# -*- mode: ruby -*-
# vi: set ft=ruby :

Vagrant.configure("2") do |config|
  # Alpine Linux の軽量公式ベースイメージ
  config.vm.box = "generic/alpine319"

  # ネットワーク
  # ホスト側の 58080番 へのアクセスを Alpine の 80番 へ転送
  # host_ip: "127.0.0.1" でLAN内からのアクセスを完全遮断
  config.vm.network "forwarded_port",
    guest: 80,
    host: 58080,
    host_ip: "127.0.0.1",
    auto_correct: true

  # 共有フォルダー
  # ホスト側の ./app を Alpine の /mnt/app に読み取り専用（ro）でマウント
  config.vm.synced_folder "./app", "/mnt/app",
    mount_options: ["ro", "dmode=755", "fmode=644"]

  # VirtualBox ハードウェア設定
  config.vm.provider "virtualbox" do |vb|
    vb.name   = "adventure-land-codeserver"
    vb.cpus   = 1
    vb.memory = "256"
  end

  # OS起動時の自動セットアップ
  config.vm.provision "shell", inline: <<-'SHELL'
    set -e

    apk update
    apk add --no-cache nginx

    if ! id -u gameuser >/dev/null 2>&1; then
      addgroup -S gamegroup
      adduser -S -D -H -h /mnt/app -s /sbin/nologin -G gamegroup gameuser
    fi

    mkdir -p /var/log/nginx /var/lib/nginx/tmp /run/nginx
    chown -R gameuser:gamegroup /var/log/nginx /var/lib/nginx /run/nginx

    cat <<'EOF' > /etc/nginx/nginx.conf
user gameuser gamegroup;
worker_processes 1;
pid /run/nginx/nginx.pid;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 64;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    server_tokens off;
    sendfile on;
    keepalive_timeout 65;
    access_log /var/log/nginx/access.log;

    server {
        listen 80;
        server_name localhost;
        root /mnt/app;
        index index.html;

        # 不要なHTTPメソッド
        if ($request_method !~ ^(GET|HEAD|OPTIONS)$ ) {
            return 405;
        }

        # アクセス禁止
        location ~ /\. {
            deny all;
            access_log off;
            log_not_found off;
        }

        location / {
            # Adventure Land向け CORS許可
            add_header Access-Control-Allow-Origin * always;
            add_header Access-Control-Allow-Methods 'GET, OPTIONS' always;
            add_header Access-Control-Allow-Headers '*' always;

            # コード即時反映用キャッシュ無効化
            add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;

            if ($request_method = OPTIONS) {
                return 204;
            }

            try_files $uri $uri/ =404;
        }
    }
}
EOF

    # サービスの起動と自動起動登録
    rc-service nginx restart || rc-service nginx start
    rc-update add nginx default
  SHELL
end
