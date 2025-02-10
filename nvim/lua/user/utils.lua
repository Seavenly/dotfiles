return {
    set_keys = function(keys, common_opts)
        for _, kmap_opts in ipairs(keys) do
            local mode = kmap_opts.mode or 'n'
            local lhs = kmap_opts[1]
            local rhs = kmap_opts[2]
            local total_opts = vim.tbl_deep_extend('force', kmap_opts, common_opts)

            total_opts[1] = nil
            total_opts[2] = nil
            total_opts.mode = nil

            vim.keymap.set(mode, lhs, rhs, total_opts)
        end
    end
}
