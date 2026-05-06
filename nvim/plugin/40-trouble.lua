-- Must load before snacks (45-snacks.lua) so require('trouble.sources.snacks') resolves there.
vim.pack.add({
    'https://github.com/nvim-tree/nvim-web-devicons',
    'https://github.com/folke/trouble.nvim',
})

require('trouble').setup({ focus = true })
