local status_ok, vim_be_good = pcall(require, "ThePrimeagen/vim-be-good")
if not status_ok then
    return
end

vim_be_good.setup()
