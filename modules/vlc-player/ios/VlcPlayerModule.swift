import ExpoModulesCore

public class VlcPlayerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VlcPlayer")

    View(VlcPlayerView.self) {
      Events("onStatus", "onProgress", "onTracks")

      Prop("source") { (view: VlcPlayerView, source: [String: Any]?) in
        view.setSource(source)
      }

      Prop("fit") { (view: VlcPlayerView, fit: String?) in
        view.fit = fit ?? "contain"
      }

      AsyncFunction("play") { (view: VlcPlayerView) in
        view.play()
      }.runOnQueue(.main)

      AsyncFunction("pause") { (view: VlcPlayerView) in
        view.pause()
      }.runOnQueue(.main)

      AsyncFunction("seekTo") { (view: VlcPlayerView, seconds: Double) in
        view.seek(to: seconds)
      }.runOnQueue(.main)

      AsyncFunction("seekBy") { (view: VlcPlayerView, seconds: Double) in
        view.seek(by: seconds)
      }.runOnQueue(.main)

      AsyncFunction("setAudioTrack") { (view: VlcPlayerView, id: Int) in
        view.setAudioTrack(id)
      }.runOnQueue(.main)

      AsyncFunction("setSubtitleTrack") { (view: VlcPlayerView, id: Int) in
        view.setSubtitleTrack(id)
      }.runOnQueue(.main)
    }
  }
}
