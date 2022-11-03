local MARKS_FILE_PATH = "~/.hammerspoon-marks.json"

local function getDeserializedMarks()
    local deserializedMarks = {}

    for k, v in pairs(hs.json.read(MARKS_FILE_PATH)) do
        local window = hs.window.filter.new(function(win) return win:id() == v.window end):getWindows()[1]
        local application = hs.application.get(v.application) or v.application

        deserializedMarks[k] = {
            window = window,
            application = application
        }
    end

    return deserializedMarks
end

local M = {
    marks = getDeserializedMarks(),
    events = {}
}

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

local function showApplication(application, window)
    if window and window:application():bundleID() == application:bundleID() then
        window:focus()
    else
        if application then
            application:activate()
        else
            markData.application = hs.application.open(application, 0, true)
        end

        markData.window = application:focusedWindow()
        hs.json.write(getSerializedMarks(), MARKS_FILE_PATH, true, true)
    end
end

hs.hotkey.bind({ "ctrl" }, "m", function()
    M.events.setMark = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
        print("keyDown", event:getCharacters(true))

        local focusedWindow = hs.window.focusedWindow()
        print("title", focusedWindow:title())

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

        local markData = M.marks[event:getCharacters(true)]

        if markData then
            local window = markData.window
            local application = markData.application

            showApplication(application, window)
        end

        M.events.gotoMark:stop()
        return true
    end)
    M.events.gotoMark:start()
end)

local chooser = hs.chooser.new(function(choice)
    if choice and choice.application then
        local window = choice.window
        local application = choice.application

        showApplication(application, window)
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
        table.insert(choices, {
            text = string.format(
                "  [%s]   %s",
                k,
                v.application:name():gsub("^%l", string.upper)
            ),
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
