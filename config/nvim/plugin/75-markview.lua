vim.pack.add({ 'https://github.com/OXY2DEV/markview.nvim' })

require('markview').setup({
    preview = {
        filetypes = { "markdown" },
        ignore_buftypes = {},
    },
})
