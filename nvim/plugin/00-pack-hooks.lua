-- Must run before any vim.pack.add that could install nvim-treesitter.
vim.api.nvim_create_autocmd('PackChanged', {
    callback = function(ev)
        if ev.data.spec.name == 'nvim-treesitter' and ev.data.kind == 'update' then
            if not ev.data.active then vim.cmd.packadd('nvim-treesitter') end
            require('nvim-treesitter').update()
        end
    end,
})
