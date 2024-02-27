return {
    'stevearc/conform.nvim',
    event = "VeryLazy",
    opts = {
        formatters_by_ft = {
            javascript = { { "prettierd", "prettier" } }
        },
        format_on_save = {
            -- These options will be passed to conform.format()
            timeout_ms = 500,
            lsp_fallback = true,
        },
    },
    init = function(_, opts)
        local conform = require "conform"

        conform.setup(opts)

        -- Manual Format command
        vim.api.nvim_create_user_command("Format", function(args)
            local range = nil
            if args.count ~= -1 then
                local end_line = vim.api.nvim_buf_get_lines(0, args.line2 - 1, args.line2, true)[1]
                range = {
                    start = { args.line1, 0 },
                    ["end"] = { args.line2, end_line:len() },
                }
            end
            conform.format({ async = true, lsp_fallback = true, range = range })
        end, { range = true })
    end
}
