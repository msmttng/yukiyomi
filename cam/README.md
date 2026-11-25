# ユキヨミ ライブカメラ定時撮影（私用）

- 毎日 日本時間 7:00・11:00・15:00 に Google Cloud（Cloud Run ジョブ＋Cloud Scheduler）で各スキー場のライブカメラを撮影する。
- 画像は **非公開の Cloud Storage バケット** に保存し、持ち主の Google アカウントでだけ見られる閲覧ページを作る。画像は公開しない。
- 撮影対象は公開サイトの `index.html` の `SITES` から読む。カメラを追加・変更したら公開サイトを更新するだけでよい（撮影プログラムの作り直しは不要）。
- GitHub Actions は使わない。

## 作る／更新する

Cloud Shell（https://shell.cloud.google.com/）で:

```
git clone https://github.com/msmttng/yukiyomi && cd yukiyomi/cam && bash deploy.sh
```

閲覧ページ: `https://storage.cloud.google.com/yukiyomi-cam-msmttng-shots/index.html`
