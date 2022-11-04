local MARKS_FILE_PATH = "~/.hammerspoon-marks.json"

local M = {
    marks = {},
    events = {}
}

function printTable(table)
    for k, v in pairs(table) do
        print(k, v)
    end
end

local function getAllWindows()
    -- Get all visible windows across spaces, including fullscreen
    -- hs.window.filter has trouble getting minimized and hidden windows
    local visibleWindows = hs.window.filter.new():getWindows()
    -- Standard hs.window functions can't grab windows across spaces
    local minimizedWindows = hs.window.minimizedWindows()
    local invisibleWindows = hs.window.invisibleWindows()

    print("--- ALL WINDOWS ---")
    printTable(visibleWindows)
    print("--- MINIMIZED WINDOWS ---")
    printTable(minimizedWindows)
    print("--- INVISIBLE WINDOWS ---")
    printTable(invisibleWindows)

    local allWindows = {}

    for _, window in ipairs(visibleWindows) do table.insert(allWindows, window) end
    for _, window in ipairs(minimizedWindows) do table.insert(allWindows, window) end
    for _, window in ipairs(invisibleWindows) do table.insert(allWindows, window) end

    return allWindows
end

local function getDeserializedMarks()
    local status, serializedMarks = pcall(function() return hs.json.read(MARKS_FILE_PATH) end)

    if not status then
        return {}
    end

    local allWindows = getAllWindows()
    local deserializedMarks = {}

    for k, v in pairs(serializedMarks) do
        local window = nil

        for _, win in ipairs(allWindows) do
            if win:id() == v.window then
                window = win
                break
            end
        end

        local application = hs.application.get(v.application) or v.application

        deserializedMarks[k] = {
            window = window,
            application = application
        }
    end

    return deserializedMarks
end

M.marks = getDeserializedMarks()

local function getSerializedMarks()
    local serializedMarks = {}

    for k, v in pairs(M.marks) do
        serializedMarks[k] = {
            window = v.window:id(),
            application = v.application:bundleID()
        }
    end

    return serializedMarks
end

local function showApplication(application, window, key)
    print("--- showApplication ---")
    print("key ", key)
    print("application ", application)
    print("window ", window)

    if not application then return end

    if next(application:allWindows()) == nil then
        -- A closed window can be held onto so check to see if all application windows are closed

        hs.application.open(application:bundleID(), 0, true)

    elseif window and window:application():bundleID() == application:bundleID() then
        -- Check to ensure that the window ID that may have been deserialized back to a window
        -- instance wtill matches the same application

        if window:isMinimized() then
            window:unminimize()
        end

        window:focus()

    else
        -- In this scenario we were unable to recover the window from a previous state
        -- so we just show whatever window is available for the application

        application:unhide()
        application:activate()
    end

    if M.marks[key].window ~= application:focusedWindow() then
        -- If the window has been updated then we want to save it

        M.marks[key].window = application:focusedWindow()
        hs.json.write(getSerializedMarks(), MARKS_FILE_PATH, true, true)
    end
end

hs.hotkey.bind({ "ctrl" }, "m", function()
    M.events.setMark = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
        local focusedWindow = hs.window.focusedWindow()

        if focusedWindow then
            M.marks[event:getCharacters(true)] = {
                window = focusedWindow,
                application = focusedWindow:application(),
            }
            hs.notify.new(nil, {
                informativeText = string.format("Mark[%s] = %s", event:getCharacters(true),
                    focusedWindow:application():name()),
                -- subTitle = focusedWindow:application():name(),
                title = "Mark set",
                withdrawAfter = 2
            }):send()
            print(string.format("Mark[%s] = %s", event:getCharacters(true), focusedWindow:application():name()))

            hs.json.write(getSerializedMarks(), MARKS_FILE_PATH, true, true)
        end

        -- Ensure event tap event only happens once
        M.events.setMark:stop()
        return true
    end)
    -- Requires manually starting the event listener
    M.events.setMark:start()
end)

hs.hotkey.bind({ "ctrl" }, "`", function()
    M.events.gotoMark = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
        local key = event:getCharacters(true)
        local markData = M.marks[key]

        if markData then
            local window = markData.window
            local application = markData.application

            showApplication(application, window, key)
        end

        -- Ensure event tap event only happens once
        M.events.gotoMark:stop()
        return true
    end)
    -- Requires manually starting the event listener
    M.events.gotoMark:start()
end)

local chooser = hs.chooser.new(function(choice)
    if choice and choice.application then
        local key = choice.key
        local window = choice.window
        local application = choice.application

        showApplication(application, window, key)
    end
end)
chooser:rows(5)
chooser:width(40)
chooser:hideCallback(function()
    -- Reset the search box
    chooser:query(nil)
    -- Clear the develteMark keypress event
    M.events.deleteMark:stop()
end)

local function refreshChoices()
    local choices = {}

    for k, v in pairs(M.marks) do
        local text = string.format(
            "   [%s]  %s",
            k,
            v.application:name():gsub("^%l", string.upper)
        )
        local styledText = hs.styledtext.ansi(text, {
            font = {
                name = "Menlo-Regular",
                size = 20
            },
            color = { hex = "#ffffff" }
        })

        table.insert(choices, {
            text = styledText,
            key = k,
            application = v.application,
            window = v.window
        })
    end

    chooser:choices(choices)
end

M.events.deleteMark = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
    local characters = event:getCharacters(true)
    local flags = event:getFlags()

    if characters == "d" and flags.ctrl then
        local choice = chooser:selectedRowContents()

        M.marks[choice.key] = nil
        refreshChoices()
        hs.json.write(getSerializedMarks(), MARKS_FILE_PATH, true, true)

        return true
    end

    return false
end)

hs.hotkey.bind({ "ctrl" }, "Space", function()
    refreshChoices()
    chooser:show()

    M.events.deleteMark:start()
end)
