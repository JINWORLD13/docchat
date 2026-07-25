[한국어](README.md) | **日本語**

# DocChat

ドキュメント(txt, md)をアップロードすると、その内容だけを根拠に回答するRAGチャットボットです。
React、Express、PostgreSQL(pgvector)、Gemini APIで作りました。

> あわせて読む — [PORTFOLIO.ja.md](PORTFOLIO.ja.md): 技術選定とその理由 ·
> [RELIABILITY.ja.md](RELIABILITY.ja.md): 負荷・障害対応の設計と測定値 ·
> [STUDY.md](STUDY.md)(韓国語): フローごとの詳細な解説

![回答と根拠の出典](docs/demo-answer.png)

回答の上に参照したドキュメントと類似度が表示され、本文中の [1], [2] がその出典と紐づきます。

![ドキュメントになければ拒否](docs/demo-refusal.png)

ドキュメントにない内容なら、でっち上げずに拒否します。このときLLMは呼び出しすらしません。

![LLM障害注入時のダッシュボード](docs/demo-dashboard-breaker.png)

ダッシュボードからトラフィックの急増とLLM障害を直接注入し、防御レイヤー(Rate Limiter、
Admission Control、Bulkhead、Circuit Breaker)が反応する様子をリアルタイムで
確認できます。上の画面はLLMが完全に落ちた状態 — 回路はオープンになり、20件中ハードエラーは
0件で、ユーザーは出典を受け取り続けています。設計の根拠は [RELIABILITY.ja.md](RELIABILITY.ja.md) へ。

## なぜ作ったか

LLM APIを一度呼んで答えをもらうことと、信頼して使えるAI機能を作ることは
別の問題だと考えました。このプロジェクトは、その違いを自分の手で実装してみるために
始めました。検索(RAG)、根拠の表示、わからないことは「わからない」と答えること、ストリーミング応答、
トークンのロギングまで — 実際のサービスなら必要になるものを、小さなスコープの中にすべて詰め込みました。

## 動作の仕組み

```
[ドキュメントのアップロード]
ファイル → 単語単位でオーバーラップさせてチャンキング → Gemini埋め込み(768次元) → pgvectorに保存

[質問]
質問を埋め込み → コサイン類似度検索 top 5
  → 最高類似度 < しきい値 : 回答を拒否 (LLMを呼ばない)
  → 通過 : 抜粋をプロンプトに入れて生成 → SSEストリーミング
→ 根拠(出典)とトークン使用量を表示、query_logsに記録
```

## こだわったポイント

### わからないことは「わからない」と答えさせる

ドキュメントにない質問にもっともらしい答えをでっち上げるのが、RAGの最悪の失敗だと考えました。
検索された最高類似度がしきい値(デフォルト0.62)より低ければ、LLMをそもそも呼び出さずに
拒否します。もっともらしい嘘(ハルシネーション)を防ぎつつ、トークンも節約できます。しきい値は勘で決めたのではなく、サンプル
ドキュメントで関連質問(類似度0.66〜0.74)と無関係な質問(0.52〜0.59)を実測し、その間に
設定しました。ドキュメントが変わったら、質問ごとに `query_logs` に残る類似度を見て
調整し直します。

```sql
select question, refused, top_similarity from query_logs order by id desc limit 20;
```

### 回答ごとに根拠を見せる

回答に使った抜粋のファイル名、類似度、プレビューを回答の上に添え、本文にも [1], [2] の
番号を振ります。根拠は生成開始前に先に送り出すので、ストリーミング中でも出典が
見えます。

### ベクトル検索はpgvectorで

別途ベクトルDBを立てず、Postgresにvectorカラムを置いて `<=>`(コサイン距離)演算子と
HNSWインデックスで検索します。ドキュメントのメタデータとベクトルを一つのDBでまとめて
管理できる点が決め手でした。

### オーバーラップするチャンキング

チャンクの境界で文が切れると検索にヒットしないことがあるため、単語200個(空白区切り)単位で40個ずつ
オーバーラップさせて切ります。純粋関数なのでテストを付けてあります。

### 過負荷と障害に耐える設計

Rate Limiter(Token Bucket)、Admission Control(同時実行の上限 + 待機デッドライン)、
Bulkhead(読み取りプール/書き込みプールの分離)、Circuit Breaker、Graceful Degradationを自前で
実装しました。ボトルネックは推測せず、実際に負荷をかけて測定し(LLMではなくDBプールでした)、
各レイヤーの挙動を単体テストで固定しました。(`cd server && npm test` — 19件)

設計の根拠・代替案の比較・測定値は [RELIABILITY.ja.md](RELIABILITY.ja.md) にまとめています。

### ストリーミングと一時的なエラーへの対応

回答はSSEでストリーミングし、質問ごとに類似度、トークン使用量、応答時間をDBに
記録します。無料枠のrate limitを考慮して埋め込み(エンベディング)リクエストは分割して送り、APIが
一時的なエラー(429, 5xx)を返した場合は指数バックオフでリトライします。実際に開発中、
埋め込みAPIが503を返して回答が失敗するのを経験して入れた仕組みです。逆に400や
404のようにリトライしても無意味なエラーは、すぐユーザーに知らせます。

## 技術スタック

- フロントエンド: React (Vite)
- バックエンド: Node.js + Express
- DB: PostgreSQL + pgvector
- AI: Gemini API — `gemini-embedding-001`(埋め込み) + `gemini-3.6-flash`(生成)、無料枠で動作

## 実行方法

1. DBの起動(pgvector同梱、初回起動時にschema.sqlを自動適用)

```bash
docker compose up -d
```

2. サーバー

```bash
cd server
cp .env.example .env   # GEMINI_API_KEY を入力 (https://aistudio.google.com/apikey で無料発行)
npm install
npm run dev
```

3. フロントエンド

```bash
cd web
npm install
npm run dev   # http://localhost:5173
```

`sample-docs/` のドキュメント2つをアップロードして、こんなふうに質問してみてください。
(デモアプリは韓国語で応答します)

- 「返金は何日かかる?」(환불은 며칠 걸려?) → ドキュメントを根拠に回答 + 出典を表示
- 「返品の送料は誰が負担する?」(반품 배송비는 누가 부담해?) → 条件ごとに分けて回答
- 「フランスの首都は?」(프랑스의 수도는?) → 拒否(ドキュメントにない内容)

DBスキーマが適用されていない場合(ボリュームを先に作ってしまった場合):

```bash
docker exec -i docchat-db psql -U postgres -d docchat < server/schema.sql
```

## プロジェクト構成

```
server/
  index.js            Expressアプリ, /api/metrics, エラーミドルウェア
  db.js               pgコネクションプール — 読み取り/書き込み分離 (Bulkhead)
  gemini.js           埋め込み / ストリーミング生成 / 指数バックオフのリトライ
  chunk.js            オーバーラップするチャンキング
  cache.js            質問埋め込みキャッシュ (TTL)
  ratelimit.js        ユーザー別 Token Bucket リクエスト制限
  admission.js        同時実行の上限 + 待機デッドライン (load shedding)
  breaker.js          LLMサーキットブレーカー
  admin.js            障害注入エンドポイントの保護 (トークン / ループバック)
  faults.js           ランタイム障害注入スイッチ (デモ用)
  routes/
    documents.js      アップロード, 一覧, 原文閲覧(GET), 編集(PUT), 削除
    chat.js           検索 → 拒否ゲート → 回路確認 → SSEストリーミング → ロギング
  scripts/            負荷テスト, キャッシュベンチ, 防御レイヤーのデモ
  schema.sql
  *.test.js           単体テスト19件 (チャンキング·rate limit·breaker·admission)
web/
  src/
    api.js            fetch + SSEパース
    App.jsx
    components/       Sidebar(アップロード/一覧) / Chat / Message(根拠表示)
                      DocModal(閲覧·編集ポップアップ) / Dashboard(負荷·障害ダッシュボード)
sample-docs/          デモ用の架空ショッピングモールのドキュメント
docs/                 README·ポートフォリオ用スクリーンショット
docker-compose.yml    pgvector入りPostgres
```

ドキュメント一覧の項目をクリックするとポップアップが開き、原文をその場で編集・保存
できます。保存すると、そのドキュメントだけを再チャンキング・再埋め込みして検索に反映します。原文は
チャンクから復元できないため(オーバーラップさせて切っているので)、`documents.content` に別途保管しています。

## 限界と次にやりたいこと

- 会話コンテキスト(マルチターン)はありません。質問単位で動作します。
- PDFはパース品質の問題が大きいため、txt/mdに絞りました。
- 検索が埋め込みの類似度ひとつに依存しています。BM25キーワード検索を組み合わせる
  ハイブリッド検索を次に試してみたいです。
- 拒否のしきい値をログを見ながら手動で調整していますが、評価用の質問セットを
  作って自動で測定するのが次の目標です。
- クライアントが応答の途中で離脱しても、サーバーはLLMストリームを最後まで消費します。
  接続終了(close)イベントを検知して生成を中断するのが次の改善候補です。
- デプロイはNeon(pgvector対応) + Render + Netlifyの無料枠の組み合わせで公開する
  予定です。
