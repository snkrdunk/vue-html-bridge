# CLI / shared settings design review

対象コミット: `70029748830b31fb0a53db5b7bc394edb7952f0c`

## 総評

CLI を analyzer の別ホストとして置き、core・adapter・LSP から分離した方向性は妥当です。初版を one-shot、ファイル単位は逐次実行とした点も、変更容易性とリソース制御の面で適切です。

一方で、共有設定の入力／解決済み状態、明示設定ファイル、trust と外部アダプターのロード、JSON 出力の失敗時契約には、実装ごとに異なる解釈が成立する箇所があります。「CLI と LSP で同じ解析・設定・安全性を保つ」という今回の主目的に直接関わるため、以下の `must` は実装開始前に設計へ反映すべきです。

## must

### must-1: 設定の入力型と解決済み型が混同され、`maxConcurrency` の既定値を表現できない

`settings.md` §3 の `VueHtmlBridgeSettings` は全フィールド必須ですが、`maxConcurrency` と `warnVariantCount` の説明は「未指定」を前提にしています。特に `maxConcurrency` は analyzer の CPU 数ベースの既定値へ委譲するとされる一方、`defaultSettings: VueHtmlBridgeSettings` では必ず固定の数値を持たなければなりません。§6 の分解後だけ `maxConcurrency?` になっていることとも整合しません。

また、`exclude`、`externalAdapters`、`validators` などの正確な既定値が文書化されていません。初版で Markuplint が既定有効なら、既定の `validators[].adapter` が `markuplint` という ID なのか、`@vue-html-bridge/adapter-markuplint` というパッケージ名なのかも公開契約として必要です。

以下を分離してください。

- JSON／LSP／CLI レイヤーが受け取る、全フィールド省略可能な `VueHtmlBridgeSettingsInput`
- マージ後の `ResolvedVueHtmlBridgeSettings`
- analyzer の動的既定値へ委譲する値を `undefined`、`"auto"`、または別の明示的表現のどれにするか
- 全フィールドの既定値表と、数値の整数・最小値・上限値

### must-2: 不正な上位レイヤーを「安全な既定値」にするのか、下位レイヤーへフォールバックするのかが決まっていない

`validateSettings` は `Partial<VueHtmlBridgeSettings>` を返し、不正フィールドは安全な既定値へフォールバックするとされています。一方、複数レイヤーをいつ検証し、いつマージするかは定義されていません。

たとえば上位レイヤーの `externalAdapters` が不正だった場合、そのフィールドを drop すると下位レイヤーの `trusted-workspace-only` が復活します。既定値 `disabled` を出力すれば下位値を遮断します。この差は単なる実装詳細ではなく trust の挙動を変えます。同様に、CLI は設定 validation error を終了コード 2 としていますが、安全な値で解析を続けて結果を出すのか、解析開始前に停止するのかも不明です。

`resolveSettings(rawLayers)` のように検証とマージの順序を一つの規範 API にまとめ、各レイヤーの不正値が下位値を隠すか否か、warning／error 時に各ホストが解析を続けるかを定義してください。LSP と CLI の parity test は、この解決済み設定と issue の両方を比較すべきです。

### must-3: `--config <path>` を共有実装で処理する API とファイル形式がない

CLI は任意パスの明示設定ファイルを受け付けますが、settings package が公開するのは workspace root 直下の二つの候補を探索する `loadWorkspaceSettingsFile` だけです。このままでは CLI が読み込み・JSON parse・validation を独自実装するか、非公開関数へ依存することになり、共有化の目的を満たしません。

settings package に `loadSettingsFile(path, fileSystem)` または `parseSettingsDocument(...)` を追加し、少なくとも次を規定してください。

- 明示ファイルは設定オブジェクトそのものか、`package.json#vueHtmlBridge` 形式も受け付けるか
- 相対 `--config` の基準は cwd か workspace root か
- `sourcePath` と設定内相対パスの解決基準
- missing、read error、parse error、schema error の区別

実装計画の settings foundation と CLI task にも、この API と契約テストを追加する必要があります。

### must-4: `--untrusted` が無効化する範囲が設定 precedence と矛盾している

`cli.md` §5 は「workspace settings are being ignored」「every other flag and setting より優先」としています。文字どおりなら `include`／`exclude`、`maxConcurrency`、`warnVariantCount`、`--fail-on`、出力形式まで無視する余地があり、§4 の precedence や共有設定の目的と矛盾します。

無効化対象は trust-sensitive な実行設定に限定して明記してください。推奨される境界は次です。

- 保持する: ファイル選択、variant 警告値、並列数、custom elements、出力・終了条件
- 強制上書きする: external adapter のロード、Markuplint の `configFile`／`searchConfig`／plugin 等、workspace code を実行し得る adapter settings
- notice の文言も「bridge の workspace settings 全体」ではなく「workspace validator configuration and external adapters」を無視したと表現する

テストには、`--untrusted` でも安全な共有設定は効き、危険な adapter 設定だけが無効になる組み合わせを追加してください。

### must-5: JSON v1 が公開契約として未定義で、正常系と失敗系の出力モデルも両立していない

`cli.md` §7.2 は stable shape としていますが、例と「`SourceDiagnostic` から internal-only fields を除く」という説明しかなく、何が internal-only か、optional／required、未知フィールド追加の互換性、`codeDescriptionHref` や evidence の射影が決まっていません。さらに以下が未定義です。

- §6 はファイル完了ごとの render を要求するが、JSON は単一 document なので全結果の保持が必要
- 設定エラー、read error、session-level failure、internal error、SIGINT で stdout が空になるのか、部分 JSON になるのか
- exit 2 でも他 adapter の有効な診断を出すのか
- `--fail-on info|hint` があるのに summary は errors／warnings しか数えない
- deterministic order のキーにある `source` は `SourceDiagnostic` に存在しない

`CliJsonOutputV1` を TypeScript 型または JSON Schema で規範化し、全 severity の件数、run-level errors、partial／aborted の扱いを定義してください。`--format json` では、どの終了コードでも stdout が有効な JSON になるのか、解析開始前の失敗だけ空にするのかも明記し、golden test を正常系だけでなく exit 2 と中断へ広げる必要があります。text は逐次出力、JSON は明示的に buffer する、という output-mode ごとの実行モデルも必要です。

### must-6: 外部アダプターのロードと trust 判定に共有の責任主体がない

settings package は値だけを共有しますが、外部 package の解決、specifier allowlist、workspace trust、runtime shape／`apiVersion`、load failure の正規化・重複排除は language server と CLI の双方が実装する設計です。依存図には、その実装を共有できる package がありません。これは設定 parity より security-sensitive で、二重実装するとホスト間の挙動がずれる可能性が高い部分です。

`@vue-html-bridge/adapter-loader` や `@vue-html-bridge/host-runtime` のようなホスト非依存 package を追加するか、同等の共有責任主体を定義してください。そこでは loaded 済み adapter と構造化された load failure を返し、analyzer は現在どおり検証済み instance だけを受け取る構成にできます。built-in adapter の注入、module resolver、trust policy は引数にし、LSP 通知と CLI stderr／exit code への変換だけを各ホストへ残すのが適切です。

実装計画 Phase 3 task 3 と task 5 は、別々に「同じ gate」を実装するのではなく、共有実装と両ホストの contract test を参照する形に変更すべきです。

### must-7: JSON Schema の正本を CLI-only install から参照できる保証がない

settings package は schema を生成するとしていますが、配布契約と package exports が明記されておらず、実装計画は language-server が schema を ship することだけを明記しています。monorepo の設定例も `@vue-html-bridge/language-server/schema.json` を参照します。CLI だけを導入する利用者は language-server を依存に持たないため、この参照は成立しません。

`@vue-html-bridge/settings/schema.json` を正本かつ公開 export とし、設定例をそのパスへ変更してください。language-server 側の copy は後方互換 alias として残せます。pack/install smoke test では、CLI-only project から `$schema` の参照先が存在することも検証すべきです。

## should

### should-1: ファイル列挙、workspace 境界、analyzer の `uri` 構築を規定する

CLI の positional glob は cwd 基準、include は workspace root 基準ですが、`../other/File.vue`、symlink、同一ファイルへの重複 match、directory 引数、dotfile、`node_modules`、read error の扱いがありません。また analyzer の `AnalyzeRequest.uri` は必須なのに、CLI の実行手順では `filename`／`source` しか説明されていません。

初版では workspace root 外を拒否するのが最も単純です。許可するなら、設定探索・adapter session・相対出力 path の境界を別途定義してください。URI は Node の `pathToFileURL` 相当で生成し、Windows、percent encoding、symlink を含む正規化規則を契約化すべきです。重複排除と read error の exit／出力もテストへ加えてください。

### should-2: validator flag の adapter 識別子と dotted path grammar を厳密化する

`--validator` は built-in を adapter ID、external を package name で指定しますが、`--disable-validator <id>` と `--validator-setting <id>...` が config のどの entry を指すか不明です。external package が別の `adapter.id` を export する場合や、複数 package が同じ ID を返す場合もあります。

設定上の安定した entry key を導入するか、「load 前は package specifier、load 後は一意な ID」といった識別規則、重複時の error を定義してください。dotted path についても、`.` を含むキー、空 segment、array index、重複指定、`__proto__`／`constructor`／`prototype` の拒否を定める必要があります。単純なオブジェクト代入で prototype pollution を起こさない実装条件もテストしてください。

### should-3: session-level failure と部分成功の CLI ライフサイクルを決める

adapter failure isolation を維持するなら、ある adapter の session-level failure 後も他 adapter／他ファイルの解析を続け、最後に exit 2 とするのが自然です。しかし、同じ failure を各ファイルで source diagnostic として出すのか、run-level error として一度だけ出すのか、途中の有効な結果を text／JSON に残すのかが未定義です。

複数ファイル × 複数 adapter の fixture で、failure の重複排除単位、継続範囲、最終 exit、summary を固定してください。ファイル read error や adapter load error も同じ run outcome model へ載せるべきです。

### should-4: CLI/LSP parity E2E は trust と入力 snapshot を明示的に同一化する

CLI は既定 trusted、LSP は既定 untrusted なので、単に同じ fixture と設定ファイルを使っても同じ診断になるとは限りません。parity test は双方へ同じ trust policy、同じ resolved settings、同じ adapter loader 結果を明示的に渡し、disk source と LSP snapshot も同じ内容に固定してください。

別に restricted-mode parity を設け、built-in safe profile と external adapter 非ロードが一致することを確認すると、共有化の目的を実際に検証できます。

### should-5: CLI 規模の性能・メモリ計測を実装計画と risk register に追加する

既存の性能計測は主に一つの SFC と LSP 応答時間を対象にしています。CLI では数百～数千ファイルの列挙、逐次 analyze、JSON 全体の buffer、全 diagnostic の line index 変換が新しい負荷になります。

ファイル並列化を初版へ入れる必要はありませんが、Phase 2 の internal runner または Phase 3 gate で、代表的な workspace 規模の wall time、peak memory、JSON サイズを測るべきです。結果を見てから file-level concurrency や NDJSON を判断する現在の YAGNI 方針は維持できます。

### should-6: signal と終了コードの契約を完成させる

SIGINT は 130 とされていますが、SIGTERM のコードが未定義です。POSIX 慣例に従うなら 143 です。cleanup の最大待ち時間、cleanup 中の二回目の signal、JSON buffer 中断時の stdout も決めてください。

### should-7: モノレポの validator 追加要件と failure 表現をホスト中立に直す

`monorepo.md` §1 と §4 は、新 adapter が core／language-server を変更せず追加できるとしていますが、CLI も同じ条件に含めるべきです。また `apiVersion` mismatch の表現が workspace diagnostic／`window/showMessage` のみで、CLI の stderr／JSON run error／exit 2 が記載されていません。

「core、analyzer、各 host を変更せず、設定だけで追加できる」を目標にし、ホスト中立の failure を共有層で定義してから LSP／CLI の表示へ分けてください。

### should-8: JSON の絶対 `workspaceRoot` と path 表現を再検討する

絶対 workspace path は CI artifact の再現性を下げ、利用者名などをログへ持ち込みます。必須でなければ JSON では相対 path だけにするか、workspace root を opt-in にしてください。残す場合は path separator、drive letter、case、root 外の related information の表現を規定する必要があります。

## may

### may-1: CLI の標準的な非解析オプションを初版仕様へ加える

`--help`、`--version`、未知オプションの終了コードは小さくても CLI の基本契約です。色については `NO_COLOR` と `--no-color` のどちらを支援するかも決めておくと CI で扱いやすくなります。

### may-2: editor 専用設定を共有 schema の nested section に分ける

`enabled`、`validateOnChange`、`validateOnSave`、`debounceMs` を CLI が受理して無視する方式は実装可能ですが、利用者には意外です。将来 schema version を導入する際、`editor: { ... }` と host-neutral fields を分けると、CLI が何を共有するかが明瞭になります。初版では現在の flat schema のままでも構いません。

### may-3: host 境界の offset-to-position fixture を一つの共有 utility package にするか計測後に判断する

CLI と language server の変換規則は同じなので、共有 fixture は必須です。実装自体も重複して不具合が出るようなら小さな host-neutral utility へ切り出せますが、現時点で package を増やす必要まではありません。

### may-4: 新規文書の trailing whitespace を除去する

`git show --check` で `cli.md` と `settings.md` の Status 行に trailing whitespace が検出されます。仕様上の問題ではありませんが、format check を Stage A から有効にするなら先に除去しておくとよいです。

反論: この末尾 2 スペースは Markdown のハード改行(「Status:」と「Package directory:」を別行に描画するための構文)であり、意図的なものです。既存ドキュメントの Status 行にも同じものが現存します(monorepo.md、core.md、language-server.md、adapter-markuplint.md、adapter-testkit.md — `git show --check` は追加行しか検査しないため、新規 2 ファイルだけが検出されました)。新規ファイルからのみ除去すると既存ドキュメントと不整合になり描画も変わるため、除去しません。Stage A で format check を導入する際に「行末 2 スペースのハード改行を許容する」ルールにするか、全ドキュメント一括で `\` 改行等へスタイル変更するかを別途決めるのが適切です。

## 優先的な修正順

1. settings の入力／解決／validation／merge 契約を確定する（must-1～3）。
2. trust と adapter loader の共有境界を確定する（must-4、must-6）。
3. CLI の JSON／failure／file enumeration 契約を確定する（must-5、should-1、should-3）。
4. schema の配布先と package graph／implementation-plan を更新する（must-7）。
5. parity、性能、signal の contract test を実装計画へ割り当てる。
