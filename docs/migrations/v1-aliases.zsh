# Seeded once into ~/.config/dotfiles/aliases.local.zsh.
# These are machine/project-specific and intentionally stay outside Git after seeding.
alias serve="http-server . --ssl --cert ~/.ssh/localhost/localhost.cer.pem --key ~/.ssh/localhost/localhost.key.pem"
alias hurlenv="source ~/dev/hurl/scripts/set-hurl-env.sh"

# Cloud golf simulator power toggle.
alias sim-up='aws ec2 start-instances --instance-ids i-0b248d6d28e000bdf --profile sim --region us-east-1 --query "StartingInstances[0].CurrentState.Name" --output text'
alias sim-down='aws ec2 stop-instances --instance-ids i-0b248d6d28e000bdf --profile sim --region us-east-1 --query "StoppingInstances[0].CurrentState.Name" --output text'
alias sim-status='aws ec2 describe-instances --instance-ids i-0b248d6d28e000bdf --profile sim --region us-east-1 --query "Reservations[0].Instances[0].State.Name" --output text'
