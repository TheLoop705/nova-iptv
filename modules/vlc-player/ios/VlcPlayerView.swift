import AVFoundation
import ExpoModulesCore
import MediaPlayer
import MobileVLCKit
import UIKit

/// Video view backed by libVLC. Used on iOS for everything AVPlayer can't open
/// (MKV/AVI/raw MPEG-TS, MP2 audio, HEVC in TS, …) and as the fallback when AVPlayer fails.
final class VlcPlayerView: ExpoView, VLCMediaPlayerDelegate {
  let onStatus = EventDispatcher()
  let onProgress = EventDispatcher()
  let onTracks = EventDispatcher()

  private let videoView = UIView()
  private var player: VLCMediaPlayer?
  private var lastSource: [String: Any]?
  private var sourceKey: String?
  private var isLive = false
  private var lastStatus = ""
  private var lastProgressAt: TimeInterval = 0
  private var tracksSignature = ""
  private var watchdog: Timer?
  private var nowPlayingTitle: String?
  private var nowPlayingArtist: String?
  private var remoteTargets: [(MPRemoteCommand, Any)] = []
  private var backgroundObserver: NSObjectProtocol?

  var fit: String = "contain" {
    didSet { applyFit() }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    videoView.backgroundColor = .black
    videoView.frame = bounds
    videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(videoView)
    // Video apps pause when sent to the background (VLC has no Picture in Picture)
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let p = self?.player, p.isPlaying else { return }
      p.pause()
    }
  }

  deinit {
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    watchdog?.invalidate()
    player?.delegate = nil
    player?.stop()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    videoView.frame = bounds
    applyFit()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stopPlayer()
    } else if player == nil, let source = lastSource {
      // Re-attached after being detached: resume the same source
      sourceKey = nil
      setSource(source)
    }
  }

  // MARK: - Source

  func setSource(_ source: [String: Any]?) {
    lastSource = source
    guard let source, let uri = source["uri"] as? String, let url = URL(string: uri) else {
      stopPlayer()
      sourceKey = nil
      return
    }
    let key = "\(uri)#\(source["nonce"].map { "\($0)" } ?? "")"
    if key == sourceKey, player != nil { return }
    sourceKey = key
    isLive = (source["isLive"] as? Bool) ?? false
    nowPlayingTitle = source["title"] as? String
    nowPlayingArtist = source["subtitle"] as? String

    stopPlayer()
    configureAudioSession()

    let media = VLCMedia(url: url)
    var options: [String: Any] = [
      "network-caching": isLive ? 2000 : 3000,
      "http-reconnect": true,
    ]
    if let ua = source["userAgent"] as? String, !ua.isEmpty {
      options["http-user-agent"] = ua
    }
    media.addOptions(options)

    let p = VLCMediaPlayer()
    p.delegate = self
    p.drawable = videoView
    p.media = media
    player = p
    lastStatus = ""
    tracksSignature = ""
    emit("opening")
    p.play()
    startWatchdog()
  }

  private func stopPlayer() {
    watchdog?.invalidate()
    watchdog = nil
    if let p = player {
      p.delegate = nil
      p.stop()
      p.drawable = nil
    }
    player = nil
    UIApplication.shared.isIdleTimerDisabled = false
    clearNowPlaying()
  }

  // MARK: - Now Playing (lock screen / Control Center)

  private func registerRemoteCommands() {
    guard remoteTargets.isEmpty else { return }
    let center = MPRemoteCommandCenter.shared()
    func add(_ command: MPRemoteCommand, _ handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
      command.isEnabled = true
      remoteTargets.append((command, command.addTarget(handler: handler)))
    }
    add(center.playCommand) { [weak self] _ in self?.player?.play(); return .success }
    add(center.pauseCommand) { [weak self] _ in self?.player?.pause(); return .success }
    add(center.togglePlayPauseCommand) { [weak self] _ in
      guard let p = self?.player else { return .noActionableNowPlayingItem }
      if p.isPlaying { p.pause() } else { p.play() }
      return .success
    }
    center.skipForwardCommand.preferredIntervals = [10]
    center.skipBackwardCommand.preferredIntervals = [10]
    add(center.skipForwardCommand) { [weak self] _ in self?.seek(by: 10); return .success }
    add(center.skipBackwardCommand) { [weak self] _ in self?.seek(by: -10); return .success }
    add(center.changePlaybackPositionCommand) { [weak self] event in
      guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self?.seek(to: e.positionTime)
      return .success
    }
  }

  private func updateNowPlaying() {
    guard let p = player else { return }
    registerRemoteCommands()
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: nowPlayingTitle ?? "Nova",
      MPNowPlayingInfoPropertyIsLiveStream: isLive,
      MPNowPlayingInfoPropertyPlaybackRate: p.isPlaying ? Double(p.rate) : 0.0,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(p.time.intValue) / 1000,
    ]
    if let artist = nowPlayingArtist { info[MPMediaItemPropertyArtist] = artist }
    let length = Double(p.media?.length.intValue ?? 0) / 1000
    if length > 0 { info[MPMediaItemPropertyPlaybackDuration] = length }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func clearNowPlaying() {
    for (command, target) in remoteTargets { command.removeTarget(target) }
    remoteTargets.removeAll()
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  private func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .moviePlayback, options: [])
    try? session.setActive(true)
  }

  /// libVLC can sit in "opening" forever on dead links; surface that as an error.
  private func startWatchdog() {
    watchdog?.invalidate()
    watchdog = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
      guard let self, let p = self.player, !p.isPlaying else { return }
      self.emit("error", error: "The stream didn't start (timed out)")
    }
  }

  // MARK: - Commands

  func play() {
    player?.play()
  }

  func pause() {
    player?.pause()
  }

  func seek(to seconds: Double) {
    guard let p = player, p.isSeekable else { return }
    p.time = VLCTime(int: Int32(max(0, seconds) * 1000))
  }

  func seek(by seconds: Double) {
    guard let p = player, p.isSeekable else { return }
    if seconds >= 0 {
      p.jumpForward(Int32(seconds))
    } else {
      p.jumpBackward(Int32(-seconds))
    }
  }

  func setAudioTrack(_ id: Int) {
    player?.currentAudioTrackIndex = Int32(id)
    emitTracks(force: true)
  }

  func setSubtitleTrack(_ id: Int) {
    player?.currentVideoSubTitleIndex = Int32(id)
    emitTracks(force: true)
  }

  func setRate(_ rate: Double) {
    player?.rate = Float(rate)
    updateNowPlaying()
  }

  func setMuted(_ muted: Bool) {
    player?.audio?.isMuted = muted
  }

  // MARK: - Fit (contain / cover / fill)

  private func applyFit() {
    guard let p = player else { return }
    let w = Int(bounds.width.rounded())
    let h = Int(bounds.height.rounded())
    guard w > 0, h > 0 else { return }
    let ratio = "\(w):\(h)"
    switch fit {
    case "cover":
      p.videoAspectRatio = nil
      withCString(ratio) { p.videoCropGeometry = $0 }
    case "fill":
      p.videoCropGeometry = nil
      withCString(ratio) { p.videoAspectRatio = $0 }
    default:
      p.videoCropGeometry = nil
      p.videoAspectRatio = nil
    }
    p.scaleFactor = 0
  }

  /// libVLC copies the string, so a temporary buffer is enough.
  private func withCString(_ value: String, _ body: (UnsafeMutablePointer<CChar>) -> Void) {
    guard let buffer = strdup(value) else { return }
    body(buffer)
    free(buffer)
  }

  // MARK: - Events

  private func emit(_ status: String, error: String? = nil) {
    guard status != lastStatus || error != nil else { return }
    lastStatus = status
    var payload: [String: Any] = ["status": status]
    if let error { payload["error"] = error }
    onStatus(payload)
  }

  private func emitTracks(force: Bool = false) {
    guard let p = player else { return }
    func pairs(_ ids: [Any]?, _ names: [Any]?) -> [[String: Any]] {
      let idList = (ids as? [NSNumber])?.map { $0.intValue } ?? []
      let nameList = (names as? [String]) ?? []
      return zip(idList, nameList).filter { $0.0 >= 0 }.map { ["id": $0.0, "label": $0.1] }
    }
    let audio = pairs(p.audioTrackIndexes, p.audioTrackNames)
    let subs = pairs(p.videoSubTitlesIndexes, p.videoSubTitlesNames)
    let audioId = Int(p.currentAudioTrackIndex)
    let subtitleId = Int(p.currentVideoSubTitleIndex)
    let signature = "\(audio.count)|\(subs.count)|\(audioId)|\(subtitleId)"
    guard force || signature != tracksSignature else { return }
    tracksSignature = signature
    onTracks(["audio": audio, "subtitles": subs, "audioId": audioId, "subtitleId": subtitleId])
  }

  // MARK: - VLCMediaPlayerDelegate

  func mediaPlayerStateChanged(_ aNotification: Notification) {
    guard let p = player else { return }
    switch p.state {
    case .opening:
      emit("opening")
    case .buffering:
      // libVLC reports buffering continuously during normal playback
      emit(p.isPlaying ? "playing" : "buffering")
    case .playing:
      watchdog?.invalidate()
      emit("playing")
      applyFit()
      emitTracks()
      updateNowPlaying()
      UIApplication.shared.isIdleTimerDisabled = true
    case .paused:
      emit("paused")
      updateNowPlaying()
      UIApplication.shared.isIdleTimerDisabled = false
    case .ended:
      emit("ended")
      UIApplication.shared.isIdleTimerDisabled = false
    case .error:
      watchdog?.invalidate()
      emit("error", error: "VLC couldn't open this stream")
      UIApplication.shared.isIdleTimerDisabled = false
    case .esAdded:
      emitTracks()
    case .stopped:
      break
    @unknown default:
      break
    }
  }

  func mediaPlayerTimeChanged(_ aNotification: Notification) {
    guard let p = player else { return }
    if lastStatus != "playing" && p.isPlaying {
      watchdog?.invalidate()
      emit("playing")
    }
    let now = Date().timeIntervalSince1970
    guard now - lastProgressAt >= 0.5 else { return }
    lastProgressAt = now
    let position = Double(p.time.intValue) / 1000
    let duration = Double(p.media?.length.intValue ?? 0) / 1000
    onProgress(["position": max(0, position), "duration": max(0, duration)])
    emitTracks()
    if Int(now) % 5 == 0 { updateNowPlaying() }
  }
}
