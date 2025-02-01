return {
    'olimorris/codecompanion.nvim',
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
    },
    config = function(_, opts)
        local codecompanion = require 'codecompanion'
        local keymaps = require "user.keymaps"

        codecompanion.setup(opts)
        keymaps.codecompanion()
    end
}
