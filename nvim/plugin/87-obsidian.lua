vim.api.nvim_create_autocmd('FileType', {
    pattern = 'markdown',
    once = true,
    callback = function()
        -- nvim-treesitter is loaded eagerly in 10-treesitter.lua.
        -- The community fork has no required deps; picker integrates natively with snacks.
        vim.pack.add({
            { src = 'https://github.com/obsidian-nvim/obsidian.nvim', version = vim.version.range('*') },
        })

        require('obsidian').setup({
            picker = { name = "snacks.pick" },
            workspaces = {
                {
                    name = "vault",
                    path = "~/dev/vault/",
                },
            },
            ui = {
                enable = false,
            },
            notes_subdir = "0.zettlekasten",
            open_app_foreground = true,
            daily_notes = {
                folder = "5.dailies",
                date_format = "%Y-%m-%d",
                alias_format = "%B %-d, %Y",
                template = "daily.md",
            },
            templates = {
                subdir = "_templates",
                date_format = "%Y-%m-%d-%a",
                time_format = "%H:%M",
            },
            attachments = {
                img_folder = "_attachments",
            },
            callbacks = {
                post_setup = function()
                    local utils = require('user.utils')

                    local keys = {
                        { '<leader>oo', ':ObsidianOpen<CR>',                                              desc = 'Obsidian Open in App' },
                        { '<leader>ot', ':ObsidianTags<CR>',                                              desc = 'Obsidian Tags' },
                        { '<leader>od', ':ObsidianDailies<CR>',                                           desc = 'Obsidian Dailies' },
                        { '<leader>ol', ':ObsidianLinks<CR>',                                             desc = 'Obsidian Links' },
                        { '<leader>ob', ':ObsidianBacklinks<CR>',                                         desc = 'Obsidian Backlinks' },
                        { '<leader>on', ':ObsidianNew<CR>',                                               desc = 'Obsidian New Note' },
                        { '<leader>oy', ':ObsidianToday<CR>',                                             desc = 'Obsidian Today' },
                        { '<leader>op', ':ObsidianPasteImg<CR>',                                          desc = 'Obsidian Paste Image' },
                        { '<leader>oc', function() return require("obsidian").util.toggle_checkbox() end, desc = 'Obsidian Checkbox Toggle' },
                        { '<leader>so', ':ObsidianSearch<CR>',                                            desc = 'Search Obsidian' },
                        { '<leader>oe', ":ObsidianExtractNote<CR>",                                       desc = 'Obsidian Extract Note',   mode = 'v' },
                        { '<leader>ol', ":ObsidianLink<CR>",                                              desc = 'Obsidian Link',           mode = 'v' },
                        { '<leader>on', ":ObsidianLinkNew<CR>",                                           desc = 'Obsidian Link New',       mode = 'v' },
                    }

                    utils.set_keys(keys, {})
                end,
            },
            mappings = {
                ["gf"] = {
                    action = function()
                        return require("obsidian").util.gf_passthrough()
                    end,
                    opts = { noremap = false, expr = true, buffer = true },
                },
            },
            ---@param title string|?
            ---@return string
            note_id_func = function(title)
                local suffix = ""
                if title ~= nil then
                    suffix = title:gsub(" ", "-"):gsub("[^A-Za-z0-9-]", ""):lower()
                else
                    for _ = 1, 4 do
                        suffix = suffix .. string.char(math.random(65, 90))
                    end
                end
                return tostring(os.time()) .. "-" .. suffix
            end,
            follow_url_func = function(url)
                vim.fn.jobstart({ "open", url })
            end,
        })

        -- Re-emit FileType so this initial markdown buffer activates obsidian's
        -- buffer-local mappings and ftplugin paths.
        vim.api.nvim_exec_autocmds('FileType', { pattern = 'markdown' })
    end,
})
