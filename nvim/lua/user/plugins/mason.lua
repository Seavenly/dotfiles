local handlers = require("user.lsp.handlers")
local language_servers = {
    "lua_ls", "cssls", "eslint", "gopls", "html", "jsonls", "tsserver", "remark_ls", "pyright", "rust_analyzer",
    "svelte", "taplo", "yamlls"
}

return {
    "williamboman/mason-lspconfig.nvim",
    dependencies = {
        "neovim/nvim-lspconfig",           -- enable LSP
        "williamboman/mason.nvim",
        "hrsh7th/cmp-nvim-lsp",            -- lsp completions
        { 'j-hui/fidget.nvim', opts = {} } -- Useful status updates for LSP
    },
    opts = {
        ensure_installed = language_servers
    },
    config = function(_, opts)
        local lspconfig = require "lspconfig"

        handlers.setup()
        require("mason").setup()
        require("mason-lspconfig").setup(opts)

        for _, server in pairs(language_servers) do
            local lsp_opts = {
                on_attach = handlers.on_attach,
                capabilities = handlers.capabilities,
            }

            if server == "jsonls" then
                local jsonls_opts = require("user.lsp.settings.jsonls")
                lsp_opts = vim.tbl_deep_extend("force", jsonls_opts, lsp_opts)
            end

            if server == "lua_ls" then
                local lua_opts = require("user.lsp.settings.lua_ls")
                lsp_opts = vim.tbl_deep_extend("force", lua_opts, lsp_opts)
            end

            lspconfig[server].setup(lsp_opts)
        end
    end
}
