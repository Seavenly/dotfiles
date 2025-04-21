return {
    "folke/flash.nvim",
    event = "VeryLazy",
    ---@type Flash.Config
    opts = {},
    keys = {
        { "gs", function() require("flash").jump() end,       desc = "Flash" },
        { "gS", function() require("flash").treesitter() end, desc = "Flash Treesitter" },
    }
}
