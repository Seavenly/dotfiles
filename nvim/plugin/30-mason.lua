vim.pack.add({
    'https://github.com/mason-org/mason.nvim',
    'https://github.com/mason-org/mason-lspconfig.nvim',
    'https://github.com/neovim/nvim-lspconfig',
})

local language_servers = {
    "templ", "lua_ls", "cssls", "eslint", "gopls", "html", "jsonls", "ts_ls", "pyright", "rust_analyzer",
    "svelte", "taplo", "yamlls", "zls", "terraformls",
}

require('mason').setup({})
require('mason-lspconfig').setup({
    ensure_installed = language_servers,
    automatic_enable = true,
})

require('user.utils').set_keys({
    { '[d',         function() vim.diagnostic.jump({ count = -1, float = true, border = 'rounded' }) end, desc = 'Go to previous diagnostic message' },
    { ']d',         function() vim.diagnostic.jump({ count = 1, float = true, border = 'rounded' }) end,  desc = 'Go to next diagnostic message' },
    { '<leader>k',  function() vim.diagnostic.open_float({ border = 'rounded', source = true }) end,      desc = 'Open floating diagnostic message' },
    { '<leader>lr', function() vim.lsp.buf.rename() end,                                                  desc = 'LSP: Rename' },
    { '<leader>la', function() vim.lsp.buf.code_action() end,                                             desc = 'LSP: Code Actions' },
    { '<leader>ld', function() require("trouble").toggle('document_diagnostics') end,                    desc = 'LSP: Document Diagnostics' },
    { '<leader>lD', function() require("trouble").toggle('workspace_diagnostics') end,                   desc = 'LSP: Workspace Diagnostics' },
    { 'gd',         function() require("trouble").toggle('lsp_definitions') end,                         desc = 'Goto Definition' },
    { 'gD',         function() vim.lsp.buf.declaration() end,                                            desc = 'Goto Declaration' },
    { 'gr',         function() require("trouble").toggle('lsp_references') end,                          desc = 'Goto References' },
    { 'gi',         function() require("trouble").toggle('lsp_implementations') end,                     desc = 'Goto Implementations' },
    { 'gt',         function() require("trouble").toggle('lsp_type_definitions') end,                    desc = 'Goto Type Definition' },
    { 'K',          function() vim.lsp.buf.hover({ border = 'rounded' }) end,                            desc = 'Hover documentation' },
    { '<C-k>',      function() vim.lsp.buf.signature_help({ border = 'rounded' }) end,                   desc = 'Signature documentation' },
}, { silent = true })
