#!/usr/bin/env bash
# =====================================================================
# EMR Dev VM — საბაზისო მომზადება (Ubuntu Server 24.04 LTS)
# გაშვება: sudo bash bootstrap.sh
# =====================================================================
set -euo pipefail

APP_USER="${SUDO_USER:-$(whoami)}"
LAN_SUBNETS="${LAN_SUBNETS:-192.168.20.0/24 10.10.4.0/23 10.10.0.0/23}"   # ადმინ/დეველოპერების ქსელები (space-ით გამოყოფილი)

echo ">>> 1. სისტემის განახლება და ბაზისური პაკეტები"
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl gnupg git unzip htop jq chrony ufw \
                   postgresql-client make

echo ">>> 2. ჰიპერვიზორის აგენტი"
case "$(systemd-detect-virt)" in
  kvm)    apt-get install -y qemu-guest-agent && systemctl enable --now qemu-guest-agent ;;
  vmware) apt-get install -y open-vm-tools ;;
  *)      echo "ჰიპერვიზორი ვერ ამოიცნო — აგენტი გამოტოვებულია" ;;
esac

echo ">>> 3. დრო და დროის სარტყელი (აუდიტ-ლოგისთვის კრიტიკულია)"
timedatectl set-timezone Asia/Tbilisi
systemctl enable --now chrony

echo ">>> 4. Docker Engine + Compose plugin (ოფიციალური რეპოზიტორია)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$APP_USER"

# კონტეინერების ლოგების ზომის ლიმიტი (რომ დისკი არ გაივსოს)
cat > /etc/docker/daemon.json << 'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
JSON
systemctl restart docker

echo ">>> 5. Redis-ისთვის kernel პარამეტრი"
echo "vm.overcommit_memory = 1" > /etc/sysctl.d/99-redis.conf
sysctl --system >/dev/null

echo ">>> 6. დირექტორიები (production-ის სტრუქტურის ანალოგი)"
mkdir -p /opt/emr /data/{postgres,redis,minio,backups}
chown -R "$APP_USER":"$APP_USER" /opt/emr /data/backups

echo ">>> 7. Firewall (UFW)"
ufw default deny incoming
ufw default allow outgoing
for NET in $LAN_SUBNETS; do
  ufw allow from "$NET" to any port 22 proto tcp
  ufw allow from "$NET" to any port 80,443 proto tcp
done
# თავდაცვა: მიმდინარე SSH სესიის IP ყოველთვის დაშვებულია
CURRENT_IP="$(echo "${SSH_CLIENT:-}" | awk '{print $1}')"
if [ -n "$CURRENT_IP" ]; then
  ufw allow from "$CURRENT_IP" to any port 22 proto tcp comment 'bootstrap session'
fi
ufw --force enable
ufw status numbered

echo ">>> მზადაა. გამოდით და ხელახლა შედით SSH-ით (docker ჯგუფის გასააქტიურებლად)."
echo ">>> შემდეგ: გადაიღეთ VM snapshot სახელით 'clean-base'."