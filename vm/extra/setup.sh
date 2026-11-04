#!/bin/bash
# Пингвинопитек: настройка гостевой системы (выполняется один раз cloud-init)
set -x
exec > /var/log/pingvinopitek-setup.log 2>&1
export DEBIAN_FRONTEND=noninteractive
cat > /etc/apt/sources.list.d/debian.sources <<'S'
Types: deb
URIs: https://debian.osuosl.org/debian
Suites: trixie trixie-updates
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
S
rm -f /etc/apt/sources.list
apt-get update
apt-get install -y --no-install-recommends linux-image-amd64 \
  xserver-xorg-core xserver-xorg-input-libinput xserver-xorg-video-qxl xinit x11-xserver-utils \
  lightdm lightdm-gtk-greeter xfce4 xfce4-terminal xfce4-whiskermenu-plugin xfce4-taskmanager \
  thunar thunar-volman gvfs gvfs-backends tumbler mousepad ristretto xfce4-screenshooter \
  dbus-x11 at-spi2-core polkitd pkexec \
  firefox-esr firefox-esr-l10n-ru synaptic \
  spice-vdagent qemu-guest-agent davfs2 \
  locales console-setup keyboard-configuration fonts-dejavu fonts-noto-color-emoji \
  xdotool python3-gi gir1.2-glib-2.0 gnome-screenshot xclip xsel \
  pulseaudio pavucontrol \
  file-roller unzip p7zip-full sudo curl wget ca-certificates nano htop \
  adwaita-icon-theme papirus-icon-theme greybird-gtk-theme
apt-get install -y /mnt/extra/ivan-operator_1.2.7_amd64.deb
# убрать облачное ядро
if dpkg -s linux-image-amd64 >/dev/null 2>&1 && ls /boot/vmlinuz-*[0-9]-amd64 >/dev/null 2>&1; then apt-get purge -y linux-image-cloud-amd64 'linux-image-*-cloud-amd64' || true; fi
ls -la /boot /boot/grub
# локаль и раскладка
sed -i 's/^# *ru_RU.UTF-8/ru_RU.UTF-8/; s/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen
locale-gen
update-locale LANG=ru_RU.UTF-8 LANGUAGE=ru_RU:ru
cat > /etc/default/keyboard <<'K'
XKBMODEL="pc105"
XKBLAYOUT="us,ru"
XKBVARIANT=","
XKBOPTIONS="grp:alt_shift_toggle,grp_led:scroll"
K
ln -sf /usr/share/zoneinfo/Asia/Vladivostok /etc/localtime; echo Asia/Vladivostok > /etc/timezone
hostnamectl set-hostname pingvinopitek 2>/dev/null; echo pingvinopitek > /etc/hostname
sed -i 's/127.0.1.1.*/127.0.1.1 pingvinopitek/' /etc/hosts; grep -q pingvinopitek /etc/hosts || echo "127.0.1.1 pingvinopitek" >> /etc/hosts
# пользователь
id pingvin || useradd -m -s /bin/bash -G sudo,audio,video,input,netdev,davfs2 pingvin
echo 'pingvin:pingvin' | chpasswd
usermod -aG sudo,audio,video,input,davfs2 pingvin
echo 'pingvin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pingvin; chmod 440 /etc/sudoers.d/pingvin
# автологин
mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-pingvinopitek.conf <<'L'
[Seat:*]
autologin-user=pingvin
autologin-user-timeout=0
user-session=xfce
greeter-hide-users=false
L
systemctl enable lightdm qemu-guest-agent spice-vdagentd 2>/dev/null || true
systemctl set-default graphical.target
# оформление
install -Dm644 /mnt/extra/wallpaper.png /usr/share/backgrounds/pingvinopitek.png
install -Dm644 /mnt/extra/icon.png /usr/share/icons/hicolor/512x512/apps/pingvinopitek.png
install -Dm755 /mnt/extra/pingvinopitek-share /usr/local/bin/pingvinopitek-share
install -Dm644 /mnt/extra/xfce-desktop.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
install -Dm644 /mnt/extra/xsettings.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml
H=/home/pingvin
mkdir -p $H/Рабочий\ стол $H/.config/autostart $H/Документы $H/Загрузки
for d in ivan-operator firefox-esr xfce4-terminal thunar synaptic mousepad; do
  f=/usr/share/applications/$d.desktop; [ -f "$f" ] && cp "$f" "$H/Рабочий стол/" && chmod +x "$H/Рабочий стол/$d.desktop"
done
cp /mnt/extra/share.desktop "$H/Рабочий стол/Общая папка Windows.desktop"; chmod +x "$H/Рабочий стол/"*.desktop
cp /mnt/extra/share-autostart.desktop $H/.config/autostart/
cp /mnt/extra/ivan-operator-autostart.desktop $H/.config/autostart/
cat > $H/.config/user-dirs.dirs <<'U'
XDG_DESKTOP_DIR="$HOME/Рабочий стол"
XDG_DOWNLOAD_DIR="$HOME/Загрузки"
XDG_DOCUMENTS_DIR="$HOME/Документы"
U
echo ru_RU > $H/.config/user-dirs.locale
chown -R pingvin:pingvin $H
# доверие ярлыкам XFCE (без вопроса «ненадёжный ярлык»)
su - pingvin -c 'true'
# общая папка: WebDAV ведущей программы через 10.0.2.100
mkdir -p /mnt/windows
echo 'http://10.0.2.100/ /mnt/windows davfs user,noauto,uid=pingvin,gid=pingvin,_netdev 0 0' >> /etc/fstab
printf 'use_locks 0\nask_auth 0\n' >> /etc/davfs2/davfs2.conf
echo 'http://10.0.2.100/ guest guest' >> /etc/davfs2/secrets
chmod u+s /usr/sbin/mount.davfs || true
# GRUB: быстро
sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=0/; s/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet"/' /etc/default/grub
update-grub
apt-get clean; rm -rf /var/lib/apt/lists/* /tmp/*
cloud-init clean --logs || true
touch /etc/cloud/cloud-init.disabled
fstrim -av || true
OK=1; for p in xfce4 lightdm ivanoperator linux-image-amd64 qemu-guest-agent; do dpkg -s $p >/dev/null 2>&1 || { echo NOTINSTALLED $p; OK=0; }; done
grep -c menuentry /boot/grub/grub.cfg
grep -n -E '^(E|W|Err):|^Ign|not found|Unable' /var/log/pingvinopitek-setup.log | head -40 > /dev/ttyS0
[ $OK = 1 ] && echo PINGVINOPITEK_SETUP_DONE > /dev/ttyS0 || echo PINGVINOPITEK_SETUP_FAILED > /dev/ttyS0
sed -i '/PPTEXTRA/d;/cidata/d' /etc/fstab; touch /etc/cloud/cloud-init.disabled; apt-get clean; fstrim -av || true
poweroff
