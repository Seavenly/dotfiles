vim.api.nvim_create_autocmd('FileType', {
    pattern = 'markdown',
    once = true,
    callback = function()
        -- nvim-treesitter is loaded eagerly in 10-treesitter.lua.
        -- obsidian.client transitively requires plenary.async, so plenary must be added
        -- alongside the plugin itself even though the picker integrates natively with snacks.
        vim.pack.add({
            { src = 'https://github.com/nvim-lua/plenary.nvim' },
            { src = 'https://github.com/obsidian-nvim/obsidian.nvim', version = vim.version.range('*') },
        })

        require('obsidian').setup({
            picker = { name = "snacks.pick" },
            workspaces = {
                {
                    name = "notes",
                    path = vim.env.NOTES_DIR or "~/notes/",
                },
            },
            ui = {
                enable = false,
            },
            notes_subdir = "raw/notes",
            open_app_foreground = true,
            attachments = {
                img_folder = "_attachments",
            },
            callbacks = {
                post_setup = function()
                    local utils = require('user.utils')

                    local keys = {
                        { '<leader>oo', ':ObsidianOpen<CR>',                                              desc = 'Obsidian Open in App' },
                        { '<leader>ot', ':ObsidianTags<CR>',                                              desc = 'Obsidian Tags' },
                        { '<leader>ol', ':ObsidianLinks<CR>',                                             desc = 'Obsidian Links' },
                        { '<leader>ob', ':ObsidianBacklinks<CR>',                                         desc = 'Obsidian Backlinks' },
                        { '<leader>on', ':ObsidianNew<CR>',                                               desc = 'Obsidian New Note' },
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
                local date = os.date("%Y-%m-%d")
                if title ~= nil and title ~= "" then
                    local cleaned = title:gsub("[^%w%s%-]", ""):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
                    return date .. " " .. cleaned
                end
                return date .. " " .. os.date("%H%M%S")
            end,
            follow_url_func = function(url)
                vim.ui.open(url)
            end,
        })

        -- Re-emit FileType so this initial markdown buffer activates obsidian's
        -- buffer-local mappings and ftplugin paths.
        vim.api.nvim_exec_autocmds('FileType', { pattern = 'markdown' })
    end,
})
