package expo.modules.playlistpairing

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

private const val SESSION_MS = 10 * 60 * 1000L
private const val MAX_HEADER_BYTES = 16 * 1024
private const val MAX_BODY_BYTES = 32 * 1024

/**
 * A short-lived LAN-only handoff used while the playlist editor is open. The phone talks directly
 * to the TV; credentials are held in memory just long enough to emit them to JS and are never
 * written or sent to a third-party pairing service.
 */
class PlaylistPairingModule : Module() {
  @Volatile private var session: PairingServer? = null

  override fun definition() = ModuleDefinition {
    Name("PlaylistPairing")
    Events("onPlaylist")

    AsyncFunction("start") {
      stopServer()
      val server = PairingServer(::onPlaylist)
      session = server
      server.start()
      mapOf("url" to server.url, "expiresAt" to server.expiresAt.toDouble())
    }

    Function("stop") { stopServer() }
    OnDestroy { stopServer() }
  }

  private fun onPlaylist(fields: Map<String, String>) {
    sendEvent("onPlaylist", fields)
    stopServer()
  }

  @Synchronized
  private fun stopServer() {
    session?.stop()
    session = null
  }
}

private class PairingServer(private val submit: (Map<String, String>) -> Unit) {
  private val running = AtomicBoolean(true)
  private val submitted = AtomicBoolean(false)
  private val token = ByteArray(18).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  private val address = localAddress()
  private val socket = ServerSocket(0).apply { soTimeout = 1_000 }
  val expiresAt = System.currentTimeMillis() + SESSION_MS
  val url = "http://$address:${socket.localPort}/pair/$token"

  fun start() {
    Thread({ acceptLoop() }, "nova-playlist-pairing").apply { isDaemon = true }.start()
  }

  fun stop() {
    if (!running.getAndSet(false)) return
    runCatching { socket.close() }
  }

  private fun acceptLoop() {
    while (running.get() && System.currentTimeMillis() < expiresAt) {
      val client = try {
        socket.accept()
      } catch (_: SocketTimeoutException) {
        continue
      } catch (_: Exception) {
        break
      }
      Thread({ handle(client) }, "nova-playlist-pairing-client").apply { isDaemon = true }.start()
    }
    stop()
  }

  private fun handle(client: Socket) {
    client.use { connection ->
      connection.soTimeout = 8_000
      try {
        val input = BufferedInputStream(connection.getInputStream())
        val request = readRequest(input)
        val expected = "/pair/$token"
        when {
          System.currentTimeMillis() >= expiresAt -> respond(connection, 410, expiredPage())
          request.path != expected -> respond(connection, 404, messagePage("This pairing link is not valid."))
          request.method == "GET" -> respond(connection, 200, formPage())
          request.method != "POST" -> respond(connection, 405, messagePage("Method not allowed."))
          else -> {
            val fields = parseForm(request.body)
            val error = validate(fields)
            if (error != null) {
              respond(connection, 400, formPage(error))
            } else if (!submitted.compareAndSet(false, true)) {
              respond(connection, 409, messagePage("This pairing code has already been used."))
            } else {
              respond(connection, 200, successPage())
              submit(normalize(fields))
            }
          }
        }
      } catch (_: Exception) {
        runCatching { respond(connection, 400, messagePage("The request could not be read.")) }
      }
    }
  }

  private data class Request(val method: String, val path: String, val body: String)

  private fun readRequest(input: BufferedInputStream): Request {
    val header = ArrayList<Byte>()
    var matched = 0
    val ending = byteArrayOf(13, 10, 13, 10)
    while (header.size < MAX_HEADER_BYTES) {
      val next = input.read()
      if (next < 0) throw IllegalArgumentException("Incomplete request")
      header.add(next.toByte())
      matched = if (next.toByte() == ending[matched]) matched + 1 else if (next == 13) 1 else 0
      if (matched == ending.size) break
    }
    if (matched != ending.size) throw IllegalArgumentException("Headers too large")
    val lines = String(header.toByteArray(), StandardCharsets.US_ASCII).split("\r\n")
    val first = lines.firstOrNull()?.split(' ') ?: emptyList()
    if (first.size < 2) throw IllegalArgumentException("Bad request")
    val length = lines.firstOrNull { it.startsWith("Content-Length:", ignoreCase = true) }
      ?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
    if (length !in 0..MAX_BODY_BYTES) throw IllegalArgumentException("Body too large")
    val body = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val count = input.read(body, offset, length - offset)
      if (count < 0) throw IllegalArgumentException("Incomplete body")
      offset += count
    }
    return Request(first[0].uppercase(), first[1].substringBefore('?'), String(body, StandardCharsets.UTF_8))
  }

  private fun parseForm(body: String): Map<String, String> = body.split('&').filter { it.isNotEmpty() }.associate { pair ->
    val key = decode(pair.substringBefore('='))
    val value = decode(pair.substringAfter('=', ""))
    key to value
  }

  private fun decode(value: String) = URLDecoder.decode(value, StandardCharsets.UTF_8.name())

  private fun validate(fields: Map<String, String>): String? {
    val kind = fields["kind"]
    if (kind != "m3u" && kind != "xtream") return "Choose a playlist type."
    if (kind == "m3u" && !isHttpUrl(fields["url"])) return "Enter a valid http(s) playlist URL."
    if (kind == "xtream" && (!isHttpUrl(fields["server"]) || fields["username"].isNullOrBlank() || fields["password"].isNullOrEmpty())) {
      return "Server URL, username and password are required."
    }
    for (key in listOf("name", "url", "server", "username", "password", "epgUrl", "userAgent")) {
      if ((fields[key]?.length ?: 0) > 4_096) return "One of the fields is too long."
    }
    return null
  }

  private fun isHttpUrl(value: String?): Boolean = value?.trim()?.matches(Regex("https?://.+", RegexOption.IGNORE_CASE)) == true

  private fun normalize(fields: Map<String, String>) = mapOf(
    "kind" to fields["kind"].orEmpty(),
    "name" to fields["name"].orEmpty().trim(),
    "url" to fields["url"].orEmpty().trim(),
    "server" to fields["server"].orEmpty().trim(),
    "username" to fields["username"].orEmpty().trim(),
    "password" to fields["password"].orEmpty(),
    "epgUrl" to fields["epgUrl"].orEmpty().trim(),
    "userAgent" to fields["userAgent"].orEmpty().trim()
  )

  private fun respond(client: Socket, status: Int, body: String) {
    val bytes = body.toByteArray(StandardCharsets.UTF_8)
    val reason = when (status) { 200 -> "OK"; 400 -> "Bad Request"; 404 -> "Not Found"; 405 -> "Method Not Allowed"; 409 -> "Conflict"; 410 -> "Gone"; else -> "Error" }
    val headers = "HTTP/1.1 $status $reason\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n"
    BufferedOutputStream(client.getOutputStream()).use { out ->
      out.write(headers.toByteArray(StandardCharsets.US_ASCII))
      out.write(bytes)
      out.flush()
    }
  }

  private fun page(content: String, script: String = "") = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nova playlist setup</title><style>
*{box-sizing:border-box}body{margin:0;background:#07080b;color:#f3f5f9;font-family:system-ui,-apple-system,sans-serif;padding:24px}main{max-width:520px;margin:auto}header{display:flex;align-items:center;gap:12px;margin-bottom:22px}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#2f6bea;font-size:24px;font-weight:900}h1{font-size:24px;margin:0}p{color:#b7bfcc;line-height:1.45}.tabs{display:grid;grid-template-columns:1fr 1fr;background:#161a22;padding:4px;border-radius:10px;margin:22px 0 14px}.tabs label{padding:11px;text-align:center;border-radius:8px;font-weight:700}.tabs label:has(input:checked){background:#252b37}.tabs input{position:absolute;opacity:0}label.field{display:block;color:#b7bfcc;font-size:13px;font-weight:650;margin-top:14px}input[type=text],input[type=url],input[type=password]{width:100%;margin-top:6px;padding:13px;border:2px solid #2a3140;border-radius:9px;background:#1c212b;color:#f3f5f9;font:inherit}input:focus{border-color:#6fa8ff;outline:none}.optional{color:#8b93a3;font-weight:400}button{width:100%;border:0;border-radius:10px;background:#2f6bea;color:white;font-size:16px;font-weight:800;padding:15px;margin-top:24px}.note{font-size:12px;color:#8b93a3}.error{background:#3a1c24;color:#ffabb2;border-radius:8px;padding:10px 12px}.hidden{display:none}.ok{font-size:54px;color:#4ed39a;margin:30px 0 10px}
</style></head><body><main><header><div class="mark">N</div><div><h1>Nova playlist setup</h1><div class="note">Direct connection to your TV</div></div></header>$content</main>${if (script.isEmpty()) "" else "<script>$script</script>"}</body></html>"""

  private fun formPage(error: String? = null): String = page("""
${if (error == null) "" else "<div class=\"error\">${escape(error)}</div>"}<p>Enter the details from your IPTV provider. They will be sent directly to Nova on your TV.</p>
<form method="post"><div class="tabs"><label><input type="radio" name="kind" value="m3u" checked> M3U URL</label><label><input type="radio" name="kind" value="xtream"> Xtream Codes</label></div>
<label class="field">Name <span class="optional">optional</span><input type="text" name="name" autocomplete="off" placeholder="My IPTV"></label>
<div id="m3u"><label class="field">Playlist URL<input type="url" name="url" inputmode="url" placeholder="http://provider.com/get.php?…"></label></div>
<div id="xtream" class="hidden"><label class="field">Server URL<input type="url" name="server" inputmode="url" placeholder="http://provider.com:8080"></label><label class="field">Username<input type="text" name="username" autocapitalize="none" autocomplete="username"></label><label class="field">Password<input type="password" name="password" autocomplete="current-password"></label></div>
<label class="field">EPG URL <span class="optional">optional</span><input type="url" name="epgUrl" inputmode="url" placeholder="Leave empty to detect automatically"></label>
<label class="field">User-Agent <span class="optional">optional</span><input type="text" name="userAgent" autocapitalize="none" placeholder="Default"></label>
<button type="submit">Send to TV</button><p class="note">Use this only on a Wi-Fi network you trust. This one-time page expires when the TV editor closes or after 10 minutes.</p></form>
""", """const m=document.querySelector('#m3u'),x=document.querySelector('#xtream');document.querySelectorAll('[name=kind]').forEach(r=>r.addEventListener('change',()=>{const q=r.value==='xtream'&&r.checked;m.classList.toggle('hidden',q);x.classList.toggle('hidden',!q)}));""")

  private fun successPage() = page("<div class=\"ok\">&#10003;</div><h1>Sent to your TV</h1><p>You can close this page. Review the details on Nova and choose <strong>Add playlist</strong>.</p>")
  private fun expiredPage() = messagePage("This pairing link has expired. Choose the QR option again on your TV.")
  private fun messagePage(message: String) = page("<h1>Pairing unavailable</h1><p>${escape(message)}</p>")
  private fun escape(value: String) = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

  private fun localAddress(): String {
    val candidates = Collections.list(NetworkInterface.getNetworkInterfaces()).flatMap { network ->
      Collections.list(network.inetAddresses).filterIsInstance<Inet4Address>().filter { address ->
        network.isUp && !network.isLoopback && !address.isLoopbackAddress && !address.isLinkLocalAddress
      }.mapNotNull { address -> address.hostAddress?.let { host -> network.name to host } }
    }
    return candidates.sortedBy { (name, address) ->
      when {
        name.startsWith("wlan", true) || name.startsWith("wifi", true) -> 0
        address.startsWith("192.168.") || address.startsWith("10.") || address.matches(Regex("172\\.(1[6-9]|2\\d|3[01])\\..*")) -> 1
        else -> 2
      }
    }.firstOrNull()?.second ?: throw IllegalStateException("Connect the TV to the same Wi-Fi network as your phone.")
  }
}
