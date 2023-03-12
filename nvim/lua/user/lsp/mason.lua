local status_ok, mason = pcall(require, "mason")
if not status_ok then
    return
end

local status_ok, mason_lspconfig = pcall(require, "mason-lspconfig")
if not status_ok then
    return
end

local status_ok, lspconfig = pcall(require, "lspconfig")
if not status_ok then
    return
end

local handlers = require("user.lsp.handlers")
local language_servers = {
    "lua_ls", "cssls", "eslint", "gopls", "html", "jsonls", "tsserver", "remark_ls", "pyright", "rust_analyzer",
    "svelte", "taplo", "yamlls"
}

mason.setup()
mason_lspconfig.setup {
    ensure_installed = language_servers
}

for _, server in pairs(language_servers) do
    local opts = {
        on_attach = handlers.on_attach,
        capabilities = handlers.capabilities,
    }

    if server == "jsonls" then
        local jsonls_opts = require("user.lsp.settings.jsonls")
        opts = vim.tbl_deep_extend("force", jsonls_opts, opts)
    end

    if server == "lua_ls" then
        local lua_opts = require("user.lsp.settings.lua_ls")
        opts = vim.tbl_deep_extend("force", lua_opts, opts)
    end

    lspconfig[server].setup(opts)
end
