return {
    'nvim-telescope/telescope.nvim',
    dependencies = { 'nvim-lua/plenary.nvim', "folke/trouble.nvim" },
    opts = {
        defaults = {
            prompt_prefix = ' ',
            selection_caret = ' ',
            path_display = { 'smart' },
            file_ignore_patterns = { 'node_modules', 'dist', 'build' },
        },
        pickers = {
            pickers = {
                live_grep = {
                    additional_args = function(opts)
                        return { '--hidden' }
                    end
                }
            }
        },
        extensions = {},
    },
    config = function(_, opts)
        local telescope = require 'telescope'
        local trouble = require "trouble.providers.telescope"
        local keymaps = require "user.keymaps"

        opts.defaults.mappings = {
            i = { ["<c-t>"] = trouble.open_with_trouble },
            n = { ["<c-t>"] = trouble.open_with_trouble },
        }

        telescope.setup(opts)
        keymaps.telescope()
    end
}
