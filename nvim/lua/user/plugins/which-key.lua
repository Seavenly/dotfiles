return {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts = {
        preset = "helix",
        icons = {
            separator = "=>"
        }
    },
    config = function(_, opts)
        local which_key = require "which-key"

        which_key.setup(opts)
        which_key.add({
            { "<leader>h", group = "Git Hunk", mode = "n" },
            { "<leader>l", group = "LSP",      mode = "n" },
            { "<leader>o", group = "Obsidian", mode = { "n", "v" } },
            { "<leader>s", group = "Search",   mode = "n" },
        })
    end
}
