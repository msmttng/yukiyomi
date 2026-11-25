#!/bin/bash
# ユキヨミ ライブカメラ定時撮影（私用）を Google Cloud に作る／更新する。Cloud Shell で実行する:
#   git clone https://github.com/msmttng/yukiyomi && cd yukiyomi/cam && bash deploy.sh
# 何度実行しても大丈夫（あるものはそのまま使い、撮影プログラムだけ作り直す）。
set -uo pipefail
PROJECT=${PROJECT:-yukiyomi-cam-msmttng}
BILLING=${BILLING:-01ACD9-D46985-1DFDD7}   # My Billing Account
REGION=asia-northeast1
BUCKET=${PROJECT}-shots
JOB=yukiyomi-cam
SA=cam-runner@${PROJECT}.iam.gserviceaccount.com
IMAGE=${REGION}-docker.pkg.dev/${PROJECT}/yukiyomi/cam:latest
step(){ echo; echo "==== $* ===="; }
die(){ echo "!!!! 失敗: $*"; exit 1; }

step "1. プロジェクト ${PROJECT}"
gcloud projects describe "$PROJECT" >/dev/null 2>&1 || gcloud projects create "$PROJECT" --name="Yukiyomi Cam" || die "プロジェクト作成"
gcloud config set project "$PROJECT" -q
[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)')" = "True" ] || \
  gcloud billing projects link "$PROJECT" --billing-account="$BILLING" || die "請求先アカウントのリンク"

step "2. API を有効化"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com storage.googleapis.com billingbudgets.googleapis.com iam.googleapis.com || die "API 有効化"

step "3. 非公開バケット gs://${BUCKET}（撮影枠は8日で自動削除）"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention || die "バケット作成"
cat > /tmp/lifecycle.json <<'J'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":8,"matchesPrefix":["archive/"]}}]}
J
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file=/tmp/lifecycle.json -q

step "4. 実行用サービスアカウント"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create cam-runner --display-name="Yukiyomi cam runner" || die "サービスアカウント作成"
sleep 5
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin -q >/dev/null || die "バケット権限"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/run.invoker --condition=None -q >/dev/null || die "起動権限"

step "5. 撮影プログラムを作る（Cloud Build）"
gcloud artifacts repositories describe yukiyomi --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create yukiyomi --repository-format=docker --location="$REGION" || die "置き場作成"
cat > /tmp/cleanup.json <<'J'
[{"name":"keep-2","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":2}},
 {"name":"delete-old","action":{"type":"Delete"},"condition":{"olderThan":"1d"}}]
J
gcloud artifacts repositories set-cleanup-policies yukiyomi --location="$REGION" --policy=/tmp/cleanup.json --no-dry-run -q >/dev/null || true
cp ../index.html ./index.html
gcloud builds submit --tag "$IMAGE" . || die "ビルド"

step "6. Cloud Run ジョブ ${JOB}"
gcloud run jobs deploy "$JOB" --image="$IMAGE" --region="$REGION" --service-account="$SA" \
  --set-env-vars="BUCKET=$BUCKET" --cpu=2 --memory=4Gi --task-timeout=30m --max-retries=0 --tasks=1 -q || die "ジョブ作成"

step "7. 定時実行（日本時間 7:00・11:00・15:00）"
URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
if gcloud scheduler jobs describe yukiyomi-cam-3x --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http yukiyomi-cam-3x --location="$REGION" --schedule="0 7,11,15 * * *" --time-zone="Asia/Tokyo" \
    --uri="$URI" --http-method=POST --oauth-service-account-email="$SA" -q || die "定時実行の更新"
else
  gcloud scheduler jobs create http yukiyomi-cam-3x --location="$REGION" --schedule="0 7,11,15 * * *" --time-zone="Asia/Tokyo" \
    --uri="$URI" --http-method=POST --oauth-service-account-email="$SA" || die "定時実行の作成"
fi

step "8. 予算アラート（月300円で通知）"
if ! gcloud billing budgets list --billing-account="$BILLING" --format='value(displayName)' 2>/dev/null | grep -qx "yukiyomi-cam"; then
  gcloud billing budgets create --billing-account="$BILLING" --display-name="yukiyomi-cam" --budget-amount=300JPY \
    --filter-projects="projects/$PROJECT" --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 || echo "（予算アラートは作れませんでした。後で画面から作ります）"
fi

if [ "${RUN_NOW:-1}" = "1" ]; then
  step "9. 試しに1回撮影"
  gcloud run jobs execute "$JOB" --region="$REGION" --wait || echo "（撮影ジョブが失敗しました。ログを確認します）"
fi

echo
echo "完了。閲覧ページ（自分のアカウントでのみ表示）:"
echo "  https://storage.cloud.google.com/${BUCKET}/index.html"
