import XCTest
import UIKit

// This target attaches to the separately installed Release app on an isolated simulator.
final class NovaPerformanceUITests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "com.theloop705.nova")
  func element(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }
  func fixtureStats() throws -> [String: Any] {
    let config = Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json")!
    let document = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as! [String: String]
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<[String: Any], Error>?
    URLSession.shared.dataTask(with: URL(string: document["url"]! + "/__test/stats")!) { data, _, error in
      defer { semaphore.signal() }
      do {
        if let error = error { throw error }
        result = .success(try JSONSerialization.jsonObject(with: data!) as! [String: Any])
      } catch { result = .failure(error) }
    }.resume()
    XCTAssertEqual(semaphore.wait(timeout: .now() + 10), .success, "Fixture stats timed out")
    return try XCTUnwrap(result).get()
  }
  func showControls() {
    if !element("player-position").exists {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.35)).tap()
    }
    XCTAssertTrue(element("player-position").waitForExistence(timeout: 3))
  }
  func changingPixels(_ before: UIImage, _ after: UIImage) -> Int {
    guard let a = before.cgImage, let b = after.cgImage,
          let ad = a.dataProvider?.data, let bd = b.dataProvider?.data,
          let ap = CFDataGetBytePtr(ad), let bp = CFDataGetBytePtr(bd) else { return 0 }
    guard a.width == b.width, a.height == b.height, a.bitsPerPixel >= 24, b.bitsPerPixel == a.bitsPerPixel else { return 0 }
    let stride = a.bitsPerPixel / 8
    var changed = 0
    // Time labels and control borders live around the edges; sample the video center.
    for y in Int(Double(a.height) * 0.35)..<Int(Double(a.height) * 0.60) {
      for x in Int(Double(a.width) * 0.30)..<Int(Double(a.width) * 0.70) {
        let ai = y * a.bytesPerRow + x * stride, bi = y * b.bytesPerRow + x * stride
        let delta = abs(Int(ap[ai]) - Int(bp[bi])) + abs(Int(ap[ai+1]) - Int(bp[bi+1])) + abs(Int(ap[ai+2]) - Int(bp[bi+2]))
        if delta > 30 { changed += 1 }
      }
    }
    return changed
  }
  func tab(_ name: String) {
    let button = element("tab-" + name)
    XCTAssertTrue(button.waitForExistence(timeout: 10), "Missing compact tab: " + name)
    let started = Date()
    button.tap()
    XCTAssertTrue(element("screen-" + name).waitForExistence(timeout: 5), "Screen failed to open: " + name)
    let duration = Int(Date().timeIntervalSince(started) * 1000)
    print("NOVA_IOS_NAVIGATION \(name) \(duration)")
    XCTAssertLessThan(duration, 5000, "Navigation blocked for five seconds")
  }
  override func setUpWithError() throws {
    continueAfterFailure = false
    app.launch()
    XCTAssertTrue(element("screen-home").waitForExistence(timeout: 30))
  }

  func testLargeLibraryNavigationAndSearch() throws {
    tab("guide")
    // Compact guide shows channel logos rather than channel-name text.
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "All channels")).firstMatch.waitForExistence(timeout: 30))
    tab("settings")
    let requests = try fixtureStats()["requests"] as! [String: Int]
    XCTAssertEqual(requests["get_vod_streams:all"] ?? 0, 0, "Settings fetched all movies to count them")
    XCTAssertEqual(requests["get_series:all"] ?? 0, 0, "Settings fetched all series to count them")
    tab("movies")
    XCTAssertTrue(element("vod-item-movies-v5001").waitForExistence(timeout: 30))
    tab("series")
    XCTAssertTrue(element("vod-item-series-s7001").waitForExistence(timeout: 30))
    tab("search")
    let input = element("search-input")
    if input.waitForExistence(timeout: 2) {
      input.tap()
    } else {
      // iOS groups the input within the enclosing accessible Pressable. Tap its
      // visible box below the Search heading, as a touch user does.
      let title = app.staticTexts["Search"].firstMatch
      XCTAssertTrue(title.exists)
      title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1)).withOffset(CGVector(dx: 0, dy: 36)).tap()
    }
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    // Direct keyboard key taps also work when UIKit's focused text field is
    // grouped under an accessible Pressable in the application hierarchy.
    let keyboard = app.keyboards.firstMatch
    for character in "performance movie 025000" {
      if character.isNumber && !keyboard.keys["0"].exists {
        let numbers = keyboard.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label == %@ OR label == %@", "123", "more", "numbers")).firstMatch
        XCTAssertTrue(numbers.exists, "Numeric keyboard switch is missing")
        numbers.tap()
      }
      let key = keyboard.keys[character == " " ? "space" : String(character)].firstMatch
      XCTAssertTrue(key.exists, "Expected fixture query keyboard key is missing")
      key.tap()
    }
    let submit = keyboard.buttons.matching(NSPredicate(format: "label ==[c] %@", "Search")).firstMatch
    if submit.exists { submit.tap() }
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Performance Movie 025000")).firstMatch.waitForExistence(timeout: 45), "Search must render a result, not only the query field")
    // End editing without choosing a result or retaining a large keyboard tree.
    if app.keyboards.count > 0 { app.swipeDown() }
    for _ in 0..<3 {
      tab("home"); tab("guide"); tab("settings"); tab("movies"); tab("series")
    }
  }

  func testLocalMP4ProgressPauseResumeAndSeek() {
    tab("movies")
    let movie = element("vod-item-movies-v5001")
    XCTAssertTrue(movie.waitForExistence(timeout: 30))
    movie.tap()
    let play = element("detail-play")
    XCTAssertTrue(play.waitForExistence(timeout: 15))
    if !play.isHittable { app.swipeUp() }
    play.tap()
    let pause = element("player-control-playpause")
    XCTAssertTrue(pause.waitForExistence(timeout: 20))
    let progress = element("player-position")
    XCTAssertTrue(progress.waitForExistence(timeout: 20))
    let first = progress.label
    let advancing = NSPredicate { _, _ in progress.exists && progress.label != first }
    XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: advancing, evaluatedWith: nil)], timeout: 15), .completed, "AVPlayer position did not advance")
    // Controls hide after inactivity; tapping the video restores them.
    showControls()
    pause.tap()
    XCTAssertTrue(pause.label.contains("Play"), "Playback did not acknowledge pause")
    Thread.sleep(forTimeInterval: 0.4)
    let pausedPosition = progress.label
    Thread.sleep(forTimeInterval: 1)
    XCTAssertEqual(progress.label, pausedPosition, "Paused playback position advanced")
    let seek = element("player-seekbar")
    XCTAssertTrue(seek.exists && seek.isHittable)
    seek.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)).tap()
    let sought = NSPredicate { _, _ in progress.exists && progress.label != pausedPosition }
    XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: sought, evaluatedWith: nil)], timeout: 5), .completed, "Seeking did not change playback position")
    let soughtPosition = progress.label
    pause.tap()
    XCTAssertTrue(pause.label.contains("Pause"), "Playback did not acknowledge resume")
    let resumed = NSPredicate { _, _ in progress.exists && progress.label != soughtPosition }
    XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: resumed, evaluatedWith: nil)], timeout: 15), .completed)
    Thread.sleep(forTimeInterval: 4.5)
    let firstFrame = XCUIScreen.main.screenshot().image
    Thread.sleep(forTimeInterval: 1.1)
    let changed = changingPixels(firstFrame, XCUIScreen.main.screenshot().image)
    XCTAssertGreaterThan(changed, 100, "AVPlayer must display changing decoded video pixels")
    print("NOVA_IOS_DECODED_CHANGED_PIXELS \(changed)")
    showControls()
    element("player-back").tap()
  }
}
