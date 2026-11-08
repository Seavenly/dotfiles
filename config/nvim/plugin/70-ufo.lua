vim.pack.add({
    'https://github.com/kevinhwang91/promise-async',
    'https://github.com/kevinhwang91/nvim-ufo',
})

require('ufo').setup({
    provider_selector = function(bufnr, filetype, buftype)
        return { 'treesitter', 'indent' }
    end,
})
