import ThreeView from "@navara/three";
import { DefaultDescriptions, DefaultPlugin } from "@navara/three_default_plugin";

const view = new ThreeView<DefaultDescriptions>({
  // ルートT確認: 共有の水面法線テクスチャを読み込む（内蔵 waternormals.jpg）
  waterTexture: { enabled: true },
});

const defaultPlugin = new DefaultPlugin();
view.addPlugin(defaultPlugin);

// Initialization

await view.init();

// Setup scene
defaultPlugin.addDefaultPhotorealScene();

view.atmosphere.date.setHours(8);

view.toneMappingExposure = 10;

// Layer declaration

const raster = view.addSource({
  type: "raster-tile",
  url: "https://tiles.maps.eox.at/wmts?layer=s2cloudless-2020_3857&style=default" +
    "&tilematrixset=g&Service=WMTS&Request=GetTile" +
    "&Version=1.0.0&Format=image%2Fjpeg" +
    "&TileMatrix={z}&TileCol={x}&TileRow={y}",
  maxZoom: 16,
});

view.addLayer({
  type: "raster",
  source: raster,
  raster: {},
});

const terrain = view.addSource({
  type: "quantized-mesh",
  url: "https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain",
  maxZoom: 18,
  requestVertexNormals: true,
  requestWaterMask: true,
});

view.addLayer({
  type: "terrain",
  source: terrain,
  terrain: {},
});

// ルートT確認: 綺麗な海岸線（広島湾・宮島あたり）を上空から見る
view.setCamera({
  lng: 132.32,
  lat: 34.28,
  height: 9000,
  heading: 30,
  pitch: -35,
  roll: 0,
});

// Attribution

view.attribution?.add([
  {
    attributionHtml: `<a href="https://s2maps.eu">Sentinel-2 cloudless 2020</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2020)`,
  },
  {
    attribution: "© Re:Earth Terrain",
    attributionUrl: "https://terrain.reearth.land/",
  },
  {
    attribution: "© Mapterhorn",
    attributionUrl: "https://mapterhorn.com/",
  },
]);
