# Version 0.2.0 のデータ出典と再生成

ゲームは人口・標高・海岸線を加工したデータを同梱します。プレイ時に元データの API や GitHub ミラーへアクセスしません。通常の `npm ci`、`npm test`、`npm run build` には Python や元データの再取得は不要です。

## 収録データと出典

| 用途 | 元データ・取得元 | 利用条件 |
| --- | --- | --- |
| 人口 | 総務省統計局「令和2年国勢調査に関する地域メッシュ統計」の 250m 人口総数。地理院地図での配信を変換した [mghs15/population-mesh-via-gsimaps](https://github.com/mghs15/population-mesh-via-gsimaps) の PMTiles を取得 | [e-Stat 利用規約](https://www.e-stat.go.jp/terms-of-use)・[地理情報の利用条件](https://www.e-stat.go.jp/gis-terms)、[国土地理院コンテンツ利用規約](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)に基づき出典と加工内容を明示 |
| 標高 | 国土地理院 DEM10B 標高タイルを Terrain-RGB に変換した [geodig-jp/gsi-dem-terrain-rgb-tiles](https://github.com/geodig-jp/gsi-dem-terrain-rgb-tiles) の z9 PNG | 国土地理院コンテンツ利用規約／PDL1.0。出典・加工を明示。標高タイルは[公式一覧](https://maps.gsi.go.jp/development/ichiran.html)の「基本測量成果以外で出典の記載のみで利用可能」に分類 |
| 海岸線・海陸マスク | [Natural Earth 5.1.2](https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2) の `ne_10m_admin_0_countries.geojson` から日本を抽出 | [Public Domain](https://www.naturalearthdata.com/about/terms-of-use/) |

人口は人口推計モデルや主要都市への仮の重みではなく、2020 年国勢調査に基づく居住人口です。ただし、国勢調査の基本単位区を地域メッシュへ対応付けた集計であり、各住居を正確に位置表示するものではありません。[地域メッシュ統計の作成方法](https://www.stat.go.jp/data/mesh/qa.html)を参照してください。人口からゲーム内資産への換算は架空であり、実際の資産・通貨・被害額・人的被害ではありません。

Natural Earth の `10m` は **1:10,000,000（1,000 万分の 1）** を表し、10 メートル解像度ではありません。日本ポリゴンは海岸線表示と海陸マスクに使い、付属する人口推計属性は使用しません。

## 固定した取得元

| データ | 固定値・確認方法 |
| --- | --- |
| 人口 PMTiles | commit `1ca468d9ae1322f100a0bd000fb2d2ca0530115a`、25,632,373 bytes、SHA-256 `5512dab3921d10f4f7678cb972bd0c53e3bdcb791a7b73f6ff431724af6583c2` |
| 人口 URL | [固定コミットの population-points.pmtiles](https://raw.githubusercontent.com/mghs15/population-mesh-via-gsimaps/1ca468d9ae1322f100a0bd000fb2d2ca0530115a/docs/population-points.pmtiles) |
| 標高 PNG | commit `417d75db5ea98edf99deb32fe65708746734dc03`、253 タイル、計 12,266,406 bytes。各タイルのパス・サイズ・SHA-256 は [elevation-manifest.json](elevation-manifest.json) に収録 |
| 標高 URL | [固定コミットのタイルディレクトリ](https://github.com/geodig-jp/gsi-dem-terrain-rgb-tiles/tree/417d75db5ea98edf99deb32fe65708746734dc03/docs) |
| 標高ミラーの更新時点 | 2025-03-27。元データ全体の測量日ではなく、元の測量時期は地域により異なる |
| 海岸線 | Natural Earth `v5.1.2`、SHA-256 `239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255`。国コード `ADM0_A3 = JPN` のポリゴンと内周リングを保持し、座標を小数 6 桁に丸める |

人口の詳細は [population-manifest.json](population-manifest.json)、アプリへ同梱する加工データの詳細は [game-mesh-manifest.json](game-mesh-manifest.json) を参照してください。原本の提供元は [総務省統計局・地域メッシュ統計](https://www.stat.go.jp/data/mesh/index.html)と [地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)です。ネットワークで取得するのは上記の固定ミラーであり、公式サイトから今回直接取得したと表示しないでください。

## グリッドと集計

集計範囲は東経 122～154 度・北緯 20～47 度、経度刻み 1/16 度・緯度刻み 1/24 度の 512 × 648 セルです。JIS の約 5km メッシュに合わせています。セルの `ix` は西から東へ、`iy` は南から北へ増え、一次元インデックスは `iy * 512 + ix` です。経緯度メッシュなので、地上の幅・面積は緯度で変わります。

人口は PMTiles のクラスタを含まない最大ズーム 10 のみを復号し、Web Mercator のタイル座標を経緯度へ変換します。緯度 1/480 度・経度 1/320 度の 250m セルを復元し、同じセルの同じ人口を重複除去します。異なる人口が同じセルへ入った場合はエラーにします。20 × 20 セルを合計して約 5km にし、補間や都市別の人口調整は行いません。

元の国勢調査の編成が JGD2000／JGD2011 のどちらかは、人口ミラーに記載がありません。そのため元測地系を断定していません。ミラーの Web Mercator 座標とゲーム用の粗い経緯度グリッドへの変換を記録しています。JGD2000／JGD2011 は同じメッシュコードでも区画・人口が異なり得るため、別の原本と組み合わせて人口を追加する場合は[公式留意事項](https://www.stat.go.jp/data/mesh/pdf/ryuijikou.pdf)を確認してください。

標高は Terrain-RGB の `-10000 + (R * 65536 + G * 256 + B) * 0.1` で復号します。海岸線内にある z9 ピクセル中心の値を集め、平均・最低・最高・起伏（最高－最低）をセルごとに算出します。地形の分類はゲーム側で行います。現行設定では平均標高 500m 以上、または起伏 300m 以上を山地としています。

同梱データの海陸マスクは各セル内の 16 × 16 点でポリゴンの内外を調べたものです。内周リングも水域として保持します。海岸線で拾えない人口ありセルも、人口を捨てずに残します。ゲームでは、海陸マスクが全て水域で人口が存在するセルに限り、陸地として代替判定します。

## 再生成方法

再生成を確認した環境は Python 3.12 です。取得には `curl` も使用します。以下は Linux／macOS の例です。Python の追加パッケージはデータ作成専用で、ブラウザの実行時依存には入りません。プロジェクトのルートで実行してください。

```sh
python3 -m venv work/data-venv
work/data-venv/bin/python -m pip install pmtiles==3.8.1 mapbox-vector-tile==2.2.0 numpy==2.3.5 Pillow shapely==2.1.2

work/data-venv/bin/python scripts/build-game-mesh.py --coast-only
work/data-venv/bin/python scripts/build-population.py --download
work/data-venv/bin/python scripts/build-elevation.py --download --coastline work/data-sources/coastline/japan.geojson
work/data-venv/bin/python scripts/build-game-mesh.py
```

最初のコマンドで固定版の Natural Earth を取得・検証し、日本の海岸線を抽出します。次に人口と標高を別々に約 5km へ集計し、最後に結合します。取得済みの原本は再利用してハッシュを検証します。元ファイルが異なる場合や人口値が競合する場合は処理を停止するため、異常時に検証を外して続行しないでください。

| 出力 | 内容 |
| --- | --- |
| `work/data-sources/coastline/` | Natural Earth 原本、日本の抽出 GeoJSON |
| `work/data-sources/population/population-5km.csv` | 人口の集計結果 |
| `work/data-sources/population/population-build-report.json` | 人口の重複除去・合計・ハッシュの検証結果 |
| `work/data-sources/elevation/tiles/` | 固定版の標高原本 PNG |
| `work/data-sources/elevation/terrain-5km.csv` / `terrain-5km.metadata.json` | 標高集約・品質フラグと処理結果 |
| `work/data-sources/game-mesh-build-report.json` | 結合結果と代表地点の確認 |
| `src/data/japan-mesh.json` | 人口・標高・海陸マスクを結合したアプリ同梱データ |
| `src/data/coastline.json` | 描画に使う日本の海岸線 |
| `data-sources/game-mesh-manifest.json` | 入力・出力のハッシュ、集約方法、品質コード、件数 |

`work/` は Git の管理対象外です。原本 PMTiles、PNG、Python パッケージ、作業 CSV は公開ビルドに含めず、加工済み JSON とスクリプト・出典 manifest を管理します。`build-elevation.py` を `--coastline` なしで実行したものは、非ゼロ標高のみの検査用出力です。海陸を区別できないためゲームデータに使いません。

生成後は `npm test` と `npm run build` を実行してください。

## 品質確認と制限

人口処理はスクリプト内で以下を検証します。

- 復号した 1,345,947 件から 182,172 件の同値重複を除去し、1,163,775 セルを復元。競合する人口値は 0 件。
- 約 5km の人口を持つセルは 13,799。集計前後の合計は **126,146,099 人** で、[2020 年国勢調査の全国人口](https://www.stat.go.jp/data/kokusei/2020/kekka/pdf/02-04.pdf)と一致。
- 人口 CSV は 170,534 bytes、SHA-256 は `601f43c2bd93c3b6ba61a87be41315b0362fa9d2033e0096e2b8d7cc03dd0d43`。

全国人口との一致は総数の検査であり、各セルの位置やミラーの変換精度を個別に保証するものではありません。この固定データでは人口 CSV にないセルは人口 0 ですが、未取得のデータ一般を 0 と扱う規則ではありません。国勢調査の別項目を追加するときは、秘匿を表す `*` と 0 を区別し、合算先との二重計上を避けてください。

標高処理では、各原本 PNG のサイズと SHA-256 を検査します。現行の集約 CSV は 17,507 行で、海岸線内の標高サンプルがあるセルは 16,399、海岸線に触れるが標高サンプルがないセルは 81、海岸線外に非ゼロ標高がある差分セルは 1,027 です。海岸線内で全サンプルが 0 の 93 セルは別の状態として記録します。これらは中間 CSV の件数で、ゲームの描画セル数や人口セル数とは異なります。

最終の `japan-mesh.json` は **16,714 セル** です。人口のない海岸線外の標高セルを除き、海岸線外でも人口がある 234 セル・88,062 人を保持します。最終データの標高品質コードは以下のとおりです。

| コード | 件数 | 意味 |
| --- | --- | --- |
| `0` | 16,306 | 取得した標高サンプルを利用可能 |
| `1` | 93 | 全サンプルが 0 で埋め値との区別ができず、標高を `null` にする |
| `2` | 81 | 標高サンプルなし。標高を `null` にする |
| `3` | 234 | 一般化された海岸線の外側にある人口セル。人口を保持し、標高は `null` にする |

最終 JSON は約 1.49MB（gzip 約 262KB）、海岸線 JSON は約 159KB（gzip 約 57KB）です。gzip の値は比較用の生成時測定であり、ホスティングの実際の転送サイズを保証するものではありません。各出力の正確なハッシュは `game-mesh-manifest.json` に記録します。

標高の限界は次のとおりです。

- 元の DEM10B は約 10m の等高線由来ですが、今回取得した z9 のピクセル幅は日本付近で約 216～287m です。集計結果を 10m 精度と表示しません。最高標高も取得ピクセルの最大値で、元 DEM の真の最高点ではありません。
- ミラーの PNG はすべて不透明で、標高 0m が海・欠損の埋め値なのか、本当の標高 0m の陸地なのかを完全には区別できません。別の海岸線マスクを併用し、`zeroSampleCount` と `coverageStatus` に状態を残します。
- `sampled-all-zero` は上記の曖昧さが残るセル、`coast-only-no-samples` は標高欠損、`outside-coast-nonzero` は海岸線の一般化などによる不一致です。空の標高欄を 0 に置き換えません。ゲームでは標高不明の陸地を平地として扱い、不明であることを表示します。
- Natural Earth の縮尺によって細い海岸・小島が省略される場合があります。サンプルを得られない小島、部分的な海陸マスクのずれを含みます。
- 全国人口には南鳥島などの画面外のセルも含みます。データ全体の範囲と、ゲーム画面の東経 122～148 度・北緯 24～47 度は異なり、全国のすべてのセルへ進路を描けるわけではありません。

ゲームの資産は各人口セルの `population * meshAssetPointsPerPerson` で計算し、現在は 1 人あたり 0.005pt です。各セルをゲームの地図座標で最寄りの都市ラベルへ割り当てた表示用集計であり、行政区域の人口ではありません。人口・建物・地形から実際の金銭被害を推定するモデルではありません。

## クレジット

人口：総務省統計局「令和2年国勢調査に関する地域メッシュ統計」（地理院地図で提供）を、台風メーカー開発者が重複除去し、約 5km メッシュへ集計・加工。取得ミラー：mghs15/population-mesh-via-gsimaps。

標高：地理院タイル（標高タイル・基盤地図情報数値標高モデル）を加工した Terrain-RGB ミラーを、台風メーカー開発者が約 5km メッシュへ集計・加工。取得ミラー：geodig-jp/gsi-dem-terrain-rgb-tiles。国土地理院がゲーム用の地形分類・被害データを作成したものではありません。

海岸線：Made with Natural Earth 5.1.2, Public Domain。国別ポリゴンの抽出・ゲーム用加工は台風メーカー開発者。
