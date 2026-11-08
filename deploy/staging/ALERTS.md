# Cảnh báo vận hành (staging)

`healthcheck.sh` (cron, root, mỗi 5 phút) ghi `OK` hoặc `FAIL: <lý do>` vào `/var/lib/hcos-status/status`.
`status-server.py` (systemd, 127.0.0.1:8090, qua Caddy `/opsstatus`) trả **200 chỉ khi** file bắt đầu bằng `OK` **và** mới hơn 15 phút; ngược lại 503 (không kèm lý do). Cron chết, server chết, hay Caddy chết đều làm uptime check hỏng => email.

Kiểm tra: archive WAL đang lỗi hoặc tắt; `pg_wal` ≥ 2 GB; đĩa `/` ≥ 70%; sao lưu vật lý, sao lưu logic, đẩy ngoài máy không cũ quá 26 giờ; restore-verify gần nhất PASS; API `/readyz` và Keycloak trả lời. Lý do chi tiết: `sudo cat /var/lib/hcos-status/detail.txt`, `journalctl -t hcos-health`.

## Cài trên VM
```
cd ~/healthcareos && git pull
sudo install -m 755 deploy/staging/{healthcheck.sh,status-server.py,basebackup.sh} /usr/local/lib/hcos/
sudo install -d -m 755 /var/lib/hcos-status
sudo install -m 644 deploy/staging/hcos-status.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hcos-status
sudo -u postgres /usr/local/lib/hcos/basebackup.sh          # tạo dấu last_base_ok (bản cũ chưa ghi dấu này)
sudo /usr/local/lib/hcos/healthcheck.sh; echo "exit=$?"; cat /var/lib/hcos-status/status
curl -s -w ' %{http_code}\n' http://127.0.0.1:8090/opsstatus
echo '*/5 * * * * root /usr/local/lib/hcos/healthcheck.sh >/dev/null 2>&1' | sudo tee /etc/cron.d/hcos-health
cd deploy/staging && docker compose --env-file secrets.env up -d --force-recreate caddy     # nhận route /opsstatus (không dùng reload: bind mount một file giữ inode cũ sau git pull)
curl -s -w ' %{http_code}\n' https://smart.id.vn/opsstatus
```
Kỳ vọng: `status` là `OK`, hai lệnh curl in `OK 200`. Nếu `FAIL: ...` thì lý do chính là việc cần xử lý (đó là mục đích của nó).

## Tạo uptime check và chính sách cảnh báo (Cloud Shell)
```
PROJECT=$(gcloud config get-value project)
gcloud monitoring uptime create hcos-ops-status --resource-type=uptime-url \
  --resource-labels=host=smart.id.vn,project_id=$PROJECT --protocol=https --path=/opsstatus --period=5 --timeout=10
CHECK_ID=$(gcloud monitoring uptime list-configs --filter='displayName=hcos-ops-status' --format='value(name)' | awk -F/ '{print $NF}')
echo "CHECK_ID=$CHECK_ID"                                       # PHẢI khác rỗng
gcloud monitoring channels list --format='table(name,displayName,type)'    # chọn kênh email đã dùng cho cảnh báo uptime
CHANNEL=projects/.../notificationChannels/...                   # dán tên kênh ở trên
sed -e "s#__CHECK_ID__#$CHECK_ID#" -e "s#__CHANNEL__#$CHANNEL#" deploy/staging/alert-ops-status.json.template > /tmp/policy.json
grep -c '__' /tmp/policy.json                                   # PHẢI là 0
gcloud monitoring policies create --policy-from-file=/tmp/policy.json
```
Các cờ của `gcloud monitoring uptime create` chưa được kiểm chứng trong sandbox: nếu báo lỗi cờ, dán lỗi lại.

## Thử cảnh báo thật (bắt buộc: cảnh báo chưa thử là chưa có)
```
sudo systemctl stop hcos-status     # /opsstatus sẽ 502; chờ ~10 phút => email "HCOS ops status failing"
sudo systemctl start hcos-status    # hồi phục => email "closed"
```

## Giới hạn
- Độ trễ cảnh báo: chu kỳ cron 5 phút + chu kỳ uptime 5 phút + `duration` 60s: khoảng 5–15 phút; cron chết cần tới 15 phút để file bị coi là cũ.
- Cảnh báo đi qua đúng VM đang được giám sát: nếu cả VM chết thì uptime check cũ (`/readyz`) mới là cái báo.
- Một kênh email duy nhất; chưa có người trực, chưa có kênh thứ hai.
- `/opsstatus` công khai nhưng chỉ lộ "OK/FAIL"; `/var/lib/hcos-status/detail.txt` có lý do chi tiết, không công khai.
