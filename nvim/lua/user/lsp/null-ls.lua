local null_ls_status_ok, null_ls = pcall(require, "null-ls")
if not null_ls_status_ok then
    return
end

local augroup = vim.api.nvim_create_augroup("null_ls_formatting", {})

-- https://github.com/jose-elias-alvarez/null-ls.nvim/tree/main/lua/null-ls/builtins/formatting
local formatting = null_ls.builtins.formatting
-- https://github.com/jose-elias-alvarez/null-ls.nvim/tree/main/lua/null-ls/builtins/diagnostics
-- local diagnostics = null_ls.builtins.diagnostics

null_ls.setup({
    debug = false,
    sources = {
        formatting.prettier.with {
            filetypes = {
                "javascript",
                "javascriptreact",
                "typescript",
                "typescriptreact",
                "vue",
                "css",
                "scss",
                "less",
                "html",
                "json",
                "yaml",
                "markdown",
                "markdown.mdx",
                "graphql",
                "svelte",
                "toml"
            }
        },
        -- formatting.stylua,
    },
    -- you can reuse a shared lspconfig on_attach callback here
    -- on_attach = function(client, bufnr)
    --     if client.server_capabilities.documentFormattingProvider then
    --         vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
    --         vim.api.nvim_create_autocmd("BufWritePre", {
    --             group = augroup,
    --             buffer = bufnr,
    --             callback = function()
    --                 vim.lsp.buf.format({
    --                     bufnr = bufnr,
    --                     filter = function(client)
    --                         return client.name == "null-ls"
    --                     end
    --                 })
    --             end
    --         })
    --     end
    -- end,
})
