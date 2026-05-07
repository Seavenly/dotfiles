vim.pack.add({ 'https://github.com/folke/which-key.nvim' })

local which_key = require('which-key')
which_key.setup({
    preset = "helix",
    icons = {
        separator = "=>",
    },
})

which_key.add({
    { "<leader>h", group = "Git Hunk", mode = "n" },
    { "<leader>l", group = "LSP",      mode = "n" },
    { "<leader>o", group = "Obsidian", mode = { "n", "v" } },
    { "<leader>s", group = "Search",   mode = "n" },
})
