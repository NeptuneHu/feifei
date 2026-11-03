import Cocoa
import ServiceManagement
import WebKit

final class PetWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

final class PetController: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    let marginRight: CGFloat = 12
    let marginBottom: CGFloat = 8
    let basePigW: CGFloat = 280
    let basePigH: CGFloat = 210
    let cardWidth: CGFloat = 360
    let cardGap: CGFloat = 14

    var window: NSWindow!
    var web: WKWebView!
    var status: NSStatusItem!
    var floatItem: NSMenuItem!
    var loginItem: NSMenuItem!
    var passTimer: Timer?
    var dragMouse: NSPoint?
    var dragOrigin: NSPoint?
    var dragging = false
    var restored = false
    var metricsDirty = false
    var announcedApproval = false
    var scale: CGFloat = 1
    var cardOpen = false
    var cardPixelHeight: CGFloat = 420
    var root: URL { Bundle.main.resourceURL!.appendingPathComponent("web") }
    var pigW: CGFloat { basePigW * scale }
    var pigH: CGFloat { basePigH * scale }

    func flag(_ value: Any?, _ fallback: Bool) -> Bool {
        if let number = value as? NSNumber { return number.boolValue }
        if let bit = value as? Bool { return bit }
        return fallback
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "pet")
        web = WKWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.uiDelegate = self
        window = PetWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 240), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.isMovable = false
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        web.autoresizingMask = [.width, .height]
        window.contentView = web
        window.isReleasedWhenClosed = false
        placeDefault(save: false)
        let page = root.appendingPathComponent("app.html")
        web.loadFileURL(URL(string: page.absoluteString + "?pet=1")!, allowingReadAccessTo: root)
        window.orderFrontRegardless()
        buildMenu()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        passTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.updatePassthrough()
        }
    }

    func buildMenu() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "肥肥"
        let menu = NSMenu()
        add(menu, "打开简报", #selector(openWeb))
        add(menu, "显示或隐藏", #selector(togglePet))
        add(menu, "恢复位置与大小", #selector(resetPet))
        floatItem = add(menu, "始终置顶", #selector(toggleFloat))
        floatItem.state = .on
        loginItem = add(menu, "开机启动", #selector(toggleLogin))
        menu.addItem(.separator())
        add(menu, "退出", #selector(quitApp))
        status.menu = menu
    }

    @discardableResult
    func add(_ menu: NSMenu, _ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        return item
    }

    func windowSize() -> NSSize {
        let width = cardOpen ? max(cardWidth + marginRight + 16, pigW + marginRight + 16) : pigW + marginRight + 16
        let above = cardOpen ? cardPixelHeight + cardGap + 10 : 8
        return NSSize(width: width, height: marginBottom + pigH + above)
    }

    func screenContaining(_ point: NSPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) }
    }

    func screenFor(_ frame: NSRect) -> NSScreen? {
        var best: NSScreen?
        var area: CGFloat = 0
        for screen in NSScreen.screens {
            let hit = screen.visibleFrame.intersection(frame)
            let value = hit.width * hit.height
            if value > area {
                area = value
                best = screen
            }
        }
        return best ?? NSScreen.main
    }

    func clampOrigin(_ origin: NSPoint, size: NSSize, screen: NSScreen) -> NSPoint {
        let visible = screen.visibleFrame
        var x = origin.x
        var y = origin.y
        func pigX() -> CGFloat { x + size.width - marginRight - pigW }
        func pigY() -> CGFloat { y + marginBottom }
        if pigX() < visible.minX + 8 { x += visible.minX + 8 - pigX() }
        if pigX() + pigW > visible.maxX - 8 { x -= pigX() + pigW - (visible.maxX - 8) }
        if pigY() < visible.minY + 8 { y += visible.minY + 8 - pigY() }
        if pigY() + pigH > visible.maxY - 8 { y -= pigY() + pigH - (visible.maxY - 8) }
        if cardOpen {
            let top = y + size.height
            if top > visible.maxY - 4 { y -= top - (visible.maxY - 4) }
            if y < visible.minY { y = visible.minY }
        }
        return NSPoint(x: x, y: y)
    }

    func placeDefault(save: Bool) {
        guard let screen = NSScreen.main else { return }
        let size = windowSize()
        let visible = screen.visibleFrame
        var frame = NSRect(x: visible.maxX - size.width - 28, y: visible.minY + 24, width: size.width, height: size.height)
        frame.origin = clampOrigin(frame.origin, size: frame.size, screen: screen)
        window.setFrame(frame, display: true)
        if save { saveOrigin() }
    }

    func resize(save: Bool) {
        var frame = window.frame
        let size = windowSize()
        let anchor = NSPoint(x: frame.maxX, y: frame.minY)
        frame.size = size
        frame.origin = NSPoint(x: anchor.x - size.width, y: anchor.y)
        if let screen = screenFor(frame) {
            frame.origin = clampOrigin(frame.origin, size: frame.size, screen: screen)
        }
        window.setFrame(frame, display: true)
        web.frame = window.contentView?.bounds ?? web.frame
        if save { saveOrigin() }
    }

    func saveOrigin() {
        let defaults = UserDefaults.standard
        defaults.set(true, forKey: "petHasOrigin")
        defaults.set(Double(window.frame.origin.x), forKey: "petOriginX")
        defaults.set(Double(window.frame.origin.y), forKey: "petOriginY")
    }

    func restoreOriginIfNeeded() {
        guard !restored else { return }
        restored = true
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "petHasOrigin") else { return }
        var frame = window.frame
        frame.origin = NSPoint(x: defaults.double(forKey: "petOriginX"), y: defaults.double(forKey: "petOriginY"))
        if let screen = screenFor(frame) ?? NSScreen.main {
            frame.origin = clampOrigin(frame.origin, size: frame.size, screen: screen)
        }
        window.setFrame(frame, display: true)
    }

    func pigRect() -> NSRect {
        let frame = window.frame
        return NSRect(x: frame.maxX - marginRight - pigW, y: frame.minY + marginBottom, width: pigW, height: pigH)
    }

    func cardRect() -> NSRect {
        let frame = window.frame
        return NSRect(
            x: frame.maxX - marginRight - cardWidth,
            y: frame.minY + marginBottom + pigH + cardGap,
            width: cardWidth,
            height: cardPixelHeight
        )
    }

    func updatePassthrough() {
        guard window != nil else { return }
        if dragging {
            window.ignoresMouseEvents = false
            return
        }
        let mouse = NSEvent.mouseLocation
        var hit = pigRect().insetBy(dx: -10, dy: -8).contains(mouse)
        if cardOpen { hit = hit || cardRect().insetBy(dx: -6, dy: -6).contains(mouse) }
        window.ignoresMouseEvents = !hit
    }

    func setFloat(_ on: Bool) {
        window.level = on ? .floating : .normal
        floatItem?.state = on ? .on : .off
    }

    func publishLoginStatus() {
        guard #available(macOS 13, *) else {
            web.evaluateJavaScript("window.onLoginResult && onLoginResult(false, false)", completionHandler: nil)
            return
        }
        let status = SMAppService.mainApp.status
        let on = status == .enabled
        loginItem?.state = on ? .on : .off
        web.evaluateJavaScript("window.onLoginResult && onLoginResult(true, \(on))", completionHandler: nil)
        if status == .requiresApproval && !announcedApproval {
            announcedApproval = true
            web.evaluateJavaScript("toast('开机启动需要在系统设置的登录项里允许肥肥。')", completionHandler: nil)
        }
    }

    func setLogin(_ on: Bool) {
        guard #available(macOS 13, *) else {
            web.evaluateJavaScript("window.onLoginResult && onLoginResult(false, false)", completionHandler: nil)
            return
        }
        do {
            if on { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
        } catch {
            web.evaluateJavaScript("window.onLoginResult && onLoginResult(false, \(on))", completionHandler: nil)
            return
        }
        publishLoginStatus()
    }

    func applyMetrics(size: CGFloat, open: Bool, floatOn: Bool, cardHeight: CGFloat) {
        scale = min(1.25, max(0.75, size / 100))
        cardOpen = open
        if open && cardHeight > 80 { cardPixelHeight = cardHeight }
        setFloat(floatOn)
        if dragging {
            metricsDirty = true
            return
        }
        resize(save: false)
        restoreOriginIfNeeded()
    }

    @objc func openWeb() { openBrief(period: nil) }
    func openBrief(period: String?) {
        var parts = URLComponents(url: root.appendingPathComponent("app.html"), resolvingAgainstBaseURL: false)!
        if let period, period == "daily" {
            parts.queryItems = [URLQueryItem(name: "period", value: period)]
        }
        if let url = parts.url { NSWorkspace.shared.open(url) }
    }
    @objc func togglePet() { window.isVisible ? window.orderOut(nil) : window.orderFrontRegardless() }
    @objc func resetPet() {
        UserDefaults.standard.set(false, forKey: "petHasOrigin")
        scale = 1
        cardOpen = false
        placeDefault(save: false)
    }
    @objc func toggleFloat() { web.evaluateJavaScript("setFloat(\(window.level != .floating))", completionHandler: nil) }
    @objc func toggleLogin() { setLogin(loginItem.state != .on) }
    @objc func quitApp() { NSApp.terminate(nil) }
    @objc func screensChanged() {
        guard let screen = screenFor(window.frame) else { return }
        var frame = window.frame
        frame.origin = clampOrigin(frame.origin, size: frame.size, screen: screen)
        window.setFrame(frame, display: true)
        saveOrigin()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "dragStart":
            dragging = true
            dragMouse = NSEvent.mouseLocation
            dragOrigin = window.frame.origin
            window.ignoresMouseEvents = false
        case "dragMove":
            guard dragging, let start = dragMouse, let origin = dragOrigin else { return }
            let current = NSEvent.mouseLocation
            var next = NSPoint(x: origin.x + current.x - start.x, y: origin.y + current.y - start.y)
            if let screen = screenContaining(current) ?? window.screen {
                next = clampOrigin(next, size: window.frame.size, screen: screen)
            }
            window.setFrameOrigin(next)
        case "dragEnd":
            dragging = false
            dragMouse = nil
            dragOrigin = nil
            saveOrigin()
            if metricsDirty {
                metricsDirty = false
                resize(save: true)
            }
        case "metrics":
            let size = (body["size"] as? NSNumber).map { CGFloat(truncating: $0) } ?? 100
            let height = (body["cardHeight"] as? NSNumber).map { CGFloat(truncating: $0) } ?? 0
            applyMetrics(size: size, open: flag(body["open"], false), floatOn: flag(body["float"], true), cardHeight: height)
        case "float":
            setFloat(flag(body["on"], true))
        case "login":
            setLogin(flag(body["on"], false))
        case "card":
            cardOpen = flag(body["open"], false)
            if !dragging { resize(save: false) }
        case "web":
            openBrief(period: body["period"] as? String)
        case "reset":
            resetPet()
        case "quotes":
            let codes = body["codes"] as? [String] ?? []
            fetchQuotes(codes)
        default:
            break
        }
    }

    func fetchQuotes(_ codes: [String]) {
        let allow = [
            "000001": "https://yunhq.sse.com.cn:32042/v1/sh1/snap/000001",
            "399001": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399001",
            "399006": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399006",
            "931071": "https://yunhq.sse.com.cn:32042/v1/csi/snap/931071",
            "399363": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399363",
            "399997": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/399997",
            "931238": "https://yunhq.sse.com.cn:32042/v1/csi/snap/931238",
            "980017": "https://yunhq.sse.com.cn:32042/v1/sz1/snap/980017"
        ]
        let jobs = codes.compactMap { code -> (String, URL)? in
            guard let raw = allow[code], let url = URL(string: raw) else { return nil }
            return (code, url)
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var rows: [[String: String]] = []
        for (code, url) in jobs {
            group.enter()
            var request = URLRequest(url: url, timeoutInterval: 12)
            request.setValue("Mozilla/5.0 (compatible; FeifeiBrief/0.3)", forHTTPHeaderField: "User-Agent")
            URLSession.shared.dataTask(with: request) { data, response, _ in
                defer { group.leave() }
                guard let data, let http = response as? HTTPURLResponse, http.statusCode == 200,
                      let text = String(data: data, encoding: .utf8), text.contains("\"snap\"") else { return }
                lock.lock()
                rows.append(["code": code, "body": text])
                lock.unlock()
            }.resume()
        }
        group.notify(queue: .main) { [weak self] in
            guard let self, let data = try? JSONSerialization.data(withJSONObject: rows),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.web.evaluateJavaScript("window.onLiveQuotes(\(json))", completionHandler: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        publishLoginStatus()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }
}

let app = NSApplication.shared
let controller = PetController()
app.delegate = controller
app.run()
