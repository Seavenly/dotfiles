vim.pack.add({ 'https://github.com/folke/flash.nvim' })

require('flash').setup({})

require('user.utils').set_keys({
    { "gs", function() require("flash").jump() end,       desc = "Flash" },
    { "gS", function() require("flash").treesitter() end, desc = "Flash Treesitter" },
}, { silent = true })
