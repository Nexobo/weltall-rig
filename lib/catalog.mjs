// Fixed approved Disc 1 sources. Scene IDs come from scene-model-catalog.js;
// battle IDs come from the game-menu roster and BATTLE_GEAR_RESOURCE_MAP.
export const approvedSources = [
  {
    "id": "weltall-scene-01",
    "name": "Weltall (scene 1)",
    "kind": "scene",
    "modelNumber": 1,
    "model": {
      "id": "xg:d1:file-002145",
      "sha256": "2584a9f52d50a6be4518a582474ce3a9523d99fb9eaa71e420f56dfb8b1086a1"
    },
    "animation": {
      "id": "xg:d1:file-002144",
      "sha256": "ace45304ce982e61931b3db177938c271ac6e3f95e7eb542a590c56f1308d0fe"
    }
  },
  {
    "id": "weltall-scene-08",
    "name": "Weltall (scene 8)",
    "kind": "scene",
    "modelNumber": 8,
    "model": {
      "id": "xg:d1:file-002159",
      "sha256": "b00a8cc8c0f72487f6d1f78307a6c4c3e56bc3f7a211d83b0c265e65f48ac9e5"
    },
    "animation": {
      "id": "xg:d1:file-002158",
      "sha256": "ca59d8d9914b63e005aee6252d631d1047bf90ffdd24b86a44af79d12201a928"
    }
  },
  {
    "id": "or-weltall-scene-10",
    "name": "OR Weltall (scene 10)",
    "kind": "scene",
    "modelNumber": 10,
    "model": {
      "id": "xg:d1:file-002163",
      "sha256": "a15cece8c5928208f32faa0b40e80cffdbd0c9f0761d17e07193d23a6a43d015"
    },
    "animation": {
      "id": "xg:d1:file-002162",
      "sha256": "e4f1b682bfffac360e2326cc0dfa64ae9dc304cccc7acfea6bed69836d0104f8"
    }
  },
  {
    "id": "weltall-id-scene-38",
    "name": "Weltall-Id",
    "kind": "scene",
    "modelNumber": 38,
    "model": {
      "id": "xg:d1:file-002219",
      "sha256": "555400768ecd6067ff26611b2c49e6ca0efd56a33aaf4cfe6137dabec006fd2e"
    },
    "animation": {
      "id": "xg:d1:file-002218",
      "sha256": "dce2c724566cd206ce3207d3cbb46543a73419bdf058acc36d9542e7d03a0e15"
    }
  },
  {
    "id": "weltall-2-scene-43",
    "name": "Weltall-2 (scene)",
    "kind": "scene",
    "modelNumber": 43,
    "model": {
      "id": "xg:d1:file-002229",
      "sha256": "b3576c385efba096fa45895b2141888f68c4e2c7c0258485849d9ab61d5e0afe"
    },
    "animation": {
      "id": "xg:d1:file-002228",
      "sha256": "c29cdec622f480170005e37e3785f2fba6bbc0d3415c38612bdb6b701293adf8"
    }
  },
  {
    "id": "or-weltall-scene-49",
    "name": "OR Weltall (scene 49)",
    "kind": "scene",
    "modelNumber": 49,
    "model": {
      "id": "xg:d1:file-002241",
      "sha256": "a1de239338bff2e0ec8437b1312a074dfac2d5dc29955a0f1eea688055f99b4a"
    },
    "animation": {
      "id": "xg:d1:file-002240",
      "sha256": "0cc190f935b9d181de66cb3d157f6ca341129b44440e1e7c66c40f0bb069de7c"
    }
  },
  {
    "id": "weltall-battle",
    "name": "Weltall (battle)",
    "kind": "battle",
    "modelNumber": 1,
    "gearId": 0,
    "model": {
      "id": "xg:d1:file-002926",
      "sha256": "2584a9f52d50a6be4518a582474ce3a9523d99fb9eaa71e420f56dfb8b1086a1"
    },
    "animation": {
      "id": "xg:d1:file-002927",
      "sha256": "c02986c12dd9616a001f522ee02bbdb6c615e60f81676047b6d9580cc8cda1b1"
    }
  },
  {
    "id": "weltall-2-battle",
    "name": "Weltall-2 (battle)",
    "kind": "battle",
    "modelNumber": 2,
    "gearId": 1,
    "model": {
      "id": "xg:d1:file-002928",
      "sha256": "b3576c385efba096fa45895b2141888f68c4e2c7c0258485849d9ab61d5e0afe"
    },
    "animation": {
      "id": "xg:d1:file-002929",
      "sha256": "1c18f04fde4dc25a002a312d8840865416e83981068647bccc5ca63505edc6cb"
    }
  }
];

// One canonical model per Gear. Keep its original rig unchanged.
export const catalog = [
  {id:'weltall', name:'Weltall', primary:'weltall-battle', sources:['weltall-battle','weltall-scene-01','weltall-scene-08']},
  {id:'weltall-2', name:'Weltall-2', primary:'weltall-2-battle', sources:['weltall-2-battle','weltall-2-scene-43']},
  {id:'weltall-id', name:'Weltall-Id', primary:'weltall-id-scene-38', sources:['weltall-id-scene-38']},
  {id:'or-weltall', name:'OR Weltall', primary:'or-weltall-scene-49', sources:['or-weltall-scene-49','or-weltall-scene-10']},
];
