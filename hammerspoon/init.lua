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

local filter = hs.window.filter.new(true)

printTable(filter:getFilters())
printTable(filter:getWindows())


local function getDeserializedMarks()
    local status, serializedMarks = pcall(function() return hs.json.read(MARKS_FILE_PATH) end)

    if not status then
        return {}
    end

    local deserializedMarks = {}

    for k, v in pairs(serializedMarks) do
        local filter = hs.window.filter.new(function(win)
            -- print(window)
            return win:id() == v.window
        end):setDefaultFilter {}

        local window = filter:getWindows()[1]
        local application = hs.application.get(v.application) or v.application

        -- print(k, window)

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
    print("window", window)
    if window and window:application():bundleID() == application:bundleID() then
        if window:isVisible() then
            window:focus()
        else
            window:maximize()
        end
    else
        if application then
            print("HERE")
            printTable(application:allWindows())
            print(application:allWindows()[1]:role())
            application:allWindows()[1]:becomeMain()
            application:allWindows()[1]:maximize()
            application:activate()
            application:unhide()
        else
            M.marks[key].application = hs.application.open(application, 0, true)
        end

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
                informativeText = string.format("Mark('%s') = %s", event:getCharacters(true),
                    focusedWindow:application():name()),
                -- subTitle = focusedWindow:application():name(),
                title = "Mark set",
                withdrawAfter = 2
            }):send()
            print(string.format("Mark('%s') = %s", event:getCharacters(true), focusedWindow:application():name()))

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

        M.events.gotoMark:stop()
        return true
    end)
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
    chooser:query(nil)
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
