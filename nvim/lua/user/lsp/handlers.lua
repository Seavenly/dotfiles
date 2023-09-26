local M = {}

-- TODO: backfill this to template
M.setup = function()
    local signs = {
        { name = "DiagnosticSignError", text = "" },
        { name = "DiagnosticSignWarn",  text = "" },
        { name = "DiagnosticSignHint",  text = "" },
        { name = "DiagnosticSignInfo",  text = "" },
    }

    for _, sign in ipairs(signs) do
        vim.fn.sign_define(sign.name, { texthl = sign.name, text = sign.text, numhl = "" })
    end

    local config = {
        -- disable virtual text
        virtual_text = false,
        -- virtual_text = {
        --   source = "always",
        --   prefix = "●",
        -- },
        -- show signs
        signs = {
            active = signs,
        },
        update_in_insert = false,
        underline = true,
        severity_sort = true,
        float = {
            focusable = false,
            style = "minimal",
            border = "rounded",
            source = "always",
            header = "",
            prefix = "",
        },
    }

    vim.diagnostic.config(config)

    vim.lsp.handlers["textDocument/hover"] = vim.lsp.with(vim.lsp.handlers.hover, {
        border = "rounded",
    })

    vim.lsp.handlers["textDocument/signatureHelp"] = vim.lsp.with(vim.lsp.handlers.signature_help, {
        border = "rounded",
    })

    vim.filetype.add {
        filename = {
            ["Fastfile"] = "ruby",
        },
    }
end

local augroup_lsp_document_highlight = vim.api.nvim_create_augroup("lsp_document_highlight", {})

local function lsp_highlight_document(client, bufnr)
    -- Set autocommands conditional on server_capabilities
    if client.server_capabilities.documentHighlightProvider then
        vim.api.nvim_clear_autocmds({ group = augroup_lsp_document_highlight, buffer = bufnr })
        vim.api.nvim_create_autocmd("CursorHold", {
            group = augroup_lsp_document_highlight,
            buffer = bufnr,
            callback = function()
                vim.lsp.buf.document_highlight()
            end
        })
        vim.api.nvim_create_autocmd("CursorMoved", {
            group = augroup_lsp_document_highlight,
            buffer = bufnr,
            callback = function()
                vim.lsp.buf.clear_references()
            end
        })
    end
end

local augroup_lsp_formatting = vim.api.nvim_create_augroup("lsp_formatting", {})
-- Use "null-ls" for formatting active buffer if supported, otherwise use LSP formatting
local function lsp_formatting(client, bufnr)
    local opts = {}

    local function lsp_format()
        local null_ls_formatting_supported = false

        for _, v in pairs(vim.lsp.get_active_clients()) do
            if v.name == "null-ls" and v.server_capabilities.documentFormattingProvider then
                null_ls_formatting_supported = true
            end
        end

        vim.lsp.buf.format({
            bufnr = bufnr,
            filter = function(client)
                if (null_ls_formatting_supported) then
                    return client.name == "null-ls"
                end

                return true
            end
        })
    end

    if client.server_capabilities.documentFormattingProvider then
        vim.api.nvim_buf_create_user_command(bufnr, "Format", lsp_format, opts)

        vim.api.nvim_clear_autocmds({ group = augroup_lsp_formatting, buffer = bufnr })
        vim.api.nvim_create_autocmd("BufWritePre", {
            group = augroup_lsp_formatting,
            buffer = bufnr,
            callback = lsp_format
        })
    end
end

local function lsp_keymaps(bufnr)
    local opts = { buffer = bufnr, silent = true }

    vim.keymap.set("n", "gD", vim.lsp.buf.declaration, opts)
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
    vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
    vim.keymap.set("n", "gi", vim.lsp.buf.implementation, opts)
    vim.keymap.set("n", "<C-k>", vim.lsp.buf.signature_help, opts)
    vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts)
    vim.keymap.set("n", "gr", vim.lsp.buf.references, opts)
    vim.keymap.set("n", "<leader>ca", vim.lsp.buf.code_action, opts)
    -- vim.keymap.set("n", "<leader>f", vim.diagnostic.open_float, opts)
    vim.keymap.set("n", "[d", function() vim.diagnostic.goto_prev({ border = "rounded" }) end, opts)
    vim.keymap.set("n", "]d", function() vim.diagnostic.goto_next({ border = "rounded" }) end, opts)
    vim.keymap.set("n", "gl", function() vim.diagnostic.open_float({ border = "rounded", source = true }) end, opts)
    -- vim.keymap.set("n", "<leader>q", vim.diagnostic.setloclist, opts)
end

M.on_attach = function(client, bufnr)
    lsp_keymaps(bufnr)
    lsp_highlight_document(client, bufnr)
    lsp_formatting(client, bufnr)
end

local status_ok, cmp_nvim_lsp = pcall(require, "cmp_nvim_lsp")
if not status_ok then
    return
end

M.capabilities = cmp_nvim_lsp.default_capabilities()

return M
