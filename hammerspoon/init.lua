-- local logger = hs.logger.new("kitty-term", "debug")
local prevWindow = hs.window.frontmostWindow()
local watcher = hs.application.watcher.new(function(name, eventType, app)
    if eventType == hs.application.watcher.deactivated then
        prevWindow = app:mainWindow()
    end
end)

watcher:start()

hs.hotkey.bind({ "ctrl" }, "space", function()
    local app = hs.application.get("kitty")

    if app then
        if not app:mainWindow() then
            app:selectMenuItem({ "kitty", "New OS window" })
        elseif app:isFrontmost() then
            if app:mainWindow():isFullScreen() then
                prevWindow:focus()
            else
                app:hide()
            end
        else
            app:activate()
        end
    else
        app = hs.application.open("kitty", 0, true)
    end
end)

