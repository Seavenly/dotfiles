local keymaps = require "user.keymaps"

local M = {}

local augroup_lsp_document_highlight = vim.api.nvim_create_augroup('lsp_document_highlight', {})

local function lsp_highlight_document(client, bufnr)
    -- Set autocommands conditional on server_capabilities
    if client.server_capabilities.documentHighlightProvider then
        vim.api.nvim_clear_autocmds({ group = augroup_lsp_document_highlight, buffer = bufnr })
        vim.api.nvim_create_autocmd('CursorHold', {
            group = augroup_lsp_document_highlight,
            buffer = bufnr,
            callback = function()
                vim.lsp.buf.document_highlight()
            end
        })
        vim.api.nvim_create_autocmd('CursorMoved', {
            group = augroup_lsp_document_highlight,
            buffer = bufnr,
            callback = function()
                vim.lsp.buf.clear_references()
            end
        })
    end
end

local augroup_lsp_formatting = vim.api.nvim_create_augroup('lsp_formatting', {})

local function lsp_capabilities()
    local cmp_nvim_lsp = require 'cmp_nvim_lsp'
    local capabilities = vim.lsp.protocol.make_client_capabilities()

    return cmp_nvim_lsp.default_capabilities(capabilities)
end

M.on_attach = function(client, bufnr)
    keymaps.lsp(bufnr)
    lsp_highlight_document(client, bufnr)
end

M.capabilities = lsp_capabilities()

return M
