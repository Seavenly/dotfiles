-- Provides the textobjects.scm query files that mini.ai's gen_spec.treesitter
-- consumes via vim.treesitter.query.get(lang, 'textobjects'). Removing this
-- plugin silently breaks the `F` textobject (and any future treesitter-based
-- mini.ai textobjects) for most languages.
vim.pack.add({ 'https://github.com/nvim-treesitter/nvim-treesitter-textobjects' })
