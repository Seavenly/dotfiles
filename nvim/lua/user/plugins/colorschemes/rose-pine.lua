return {
    "rose-pine/neovim",
    opts = {
        styles = {
            transparency = true,
        }
    },
    config = function(_, opts)
        require("rose-pine").setup(opts)

        vim.cmd("colorscheme rose-pine-moon")
    end
}
