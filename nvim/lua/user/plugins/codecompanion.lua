return {
    'olimorris/codecompanion.nvim',
    keys = {
        { '<C-c>',     ':CodeCompanionActions<CR>',     desc = 'CodeCompanion Actions',  mode = { 'n', 'v' } },
        { '<leader>c', ':CodeCompanionChat Toggle<CR>', desc = 'CodeCompanion Chat' },
        { '<leader>c', ':CodeCompanionChat Add<CR>',    desc = 'CodeCompanion Chat Add', mode = 'v' }
    },
    init = function()
        -- Expand 'cc' into 'CodeCompanion' in the command line
        vim.cmd([[cab cc CodeCompanion]])
    end,
    opts = {
        strategies = {
            chat = {
                adapter = "gemini",
                slash_commands = {
                    ["buffer"] = {
                        opts = {
                            provider = "telescope",
                            contains_code = true
                        }
                    },
                    ["file"] = {
                        opts = {
                            provider = "telescope",
                            contains_code = true
                        }
                    },
                    ["symbols"] = {
                        opts = {
                            provider = "telescope",
                            contains_code = true
                        }
                    }
                }
            },
            inline = {
                adapter = "gemini"
            }
        },
        display = {
            action_palette = {
                provider = "telescope"
            }
        }
    }
}
