package expo.modules.playlistpairing

import org.junit.Assert.*
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class PairingServerTest {
  private fun request(url: String, fields: Map<String, String>? = null): Pair<Int, String> {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 2000
    conn.readTimeout = 2000
    if (fields != null) {
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
      val body = fields.entries.joinToString("&") { (k, v) -> "$k=${URLEncoder.encode(v, "UTF-8")}" }
      conn.outputStream.use { it.write(body.toByteArray()) }
    }
    return try {
      val status = conn.responseCode
      val body = (if (status >= 400) conn.errorStream else conn.inputStream).bufferedReader().use { it.readText() }
      status to body
    } finally { conn.disconnect() }
  }

  @Test fun m3uHandoffIsValidatedAndSingleUse() {
    val received = LinkedBlockingQueue<Map<String, String>>()
    val server = PairingServer({ received.add(it) }, "127.0.0.1")
    server.start()
    try {
      val (status, page) = request(server.url)
      assertEquals(200, status)
      assertTrue(page.contains("Send to TV"))
      assertEquals(404, request(server.url + "wrong").first)
      assertEquals(400, request(server.url, mapOf("kind" to "m3u", "url" to "http://")).first)
      val fields = mapOf("kind" to "m3u", "name" to "Test & TV", "url" to "https://example.com/list.m3u?user=a&token=b")
      assertEquals(200, request(server.url, fields).first)
      assertEquals(fields["url"], received.poll(2, TimeUnit.SECONDS)?.get("url"))
      assertEquals(409, request(server.url, fields).first)
      assertNull(received.poll())
    } finally { server.stop() }
  }

  @Test fun xtreamPreservesPasswordAndRejectsInvalidEpg() {
    val received = LinkedBlockingQueue<Map<String, String>>()
    val server = PairingServer({ received.add(it) }, "127.0.0.1")
    server.start()
    try {
      val fields = mapOf("kind" to "xtream", "server" to "http://example.com:8080", "username" to " demo ", "password" to " p+&ä=ss ")
      assertEquals(400, request(server.url, fields + ("epgUrl" to "file:///etc/passwd")).first)
      assertEquals(200, request(server.url, fields).first)
      val result = received.poll(2, TimeUnit.SECONDS)!!
      assertEquals("demo", result["username"])
      assertEquals(fields["password"], result["password"])
    } finally { server.stop() }
  }

  @Test fun closingTheEditorRejectsAnAlreadyConnectedRequest() {
    val received = LinkedBlockingQueue<Map<String, String>>()
    val server = PairingServer({ received.add(it) }, "127.0.0.1")
    server.start()
    val url = URL(server.url)
    try {
      Socket(url.host, url.port).use { client ->
        client.soTimeout = 2000
        // Allow the accept loop to hold the connection before closing the editor.
        client.getOutputStream().write("POST ${url.path} HTTP/1.1\r\n".toByteArray())
        Thread.sleep(50)
        server.stop()
        val body = "kind=m3u&url=https%3A%2F%2Fexample.com%2Flist.m3u"
        client.getOutputStream().write("Host: ${url.host}\r\nContent-Length: ${body.length}\r\n\r\n$body".toByteArray())
        val reply = client.getInputStream().bufferedReader().readText()
        assertTrue(reply.contains("410 Gone"))
        assertNull(received.poll())
      }
    } finally { server.stop() }
  }

  @Test fun expiredPairingDoesNotAcceptDetails() {
    val received = LinkedBlockingQueue<Map<String, String>>()
    val server = PairingServer({ received.add(it) }, "127.0.0.1", 100)
    server.start()
    try {
      Thread.sleep(150)
      try {
        assertEquals(410, request(server.url, mapOf("kind" to "m3u", "url" to "https://example.com/list.m3u")).first)
      } catch (_: java.net.ConnectException) { /* The expired listener may already be closed. */ }
      assertNull(received.poll())
    } finally { server.stop() }
  }
}
