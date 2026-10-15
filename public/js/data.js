// Editable data tables. Change any price, yield or bag size to match your area.

/** Typical backyard raised-bed figures. yield_lb_per_sqft is per planting in an intensively planted bed; price_per_lb is an approximate US supermarket retail price (USDA ERS Fruit and Vegetable Prices, rounded and inflation-adjusted); cost_per_sqft is seed or transplants per planting. kc is the FAO-56 mid-season crop coefficient used for water use. n_demand: low/med/high. gdd50 is growing degree days (base 50F) a warm-season crop needs from planting to the end of a useful harvest. Edit any number to match your store prices or your own records. */
export const CROPS = [
  {
    "id": "tomato",
    "name": "Tomatoes (slicing)",
    "season": "warm",
    "days": 75,
    "yield_lb_per_sqft": 1.5,
    "price_per_lb": 2.1,
    "cost_per_sqft": 0.75,
    "kc": 0.85,
    "n_demand": "med",
    "ph": [
      6.2,
      6.8
    ],
    "gdd50": 1300,
    "max_plantings": 1
  },
  {
    "id": "cherry_tomato",
    "name": "Cherry tomatoes",
    "season": "warm",
    "days": 65,
    "yield_lb_per_sqft": 1.2,
    "price_per_lb": 4.5,
    "cost_per_sqft": 0.75,
    "kc": 0.85,
    "n_demand": "med",
    "ph": [
      6.2,
      6.8
    ],
    "gdd50": 1200,
    "max_plantings": 1
  },
  {
    "id": "pepper",
    "name": "Bell peppers",
    "season": "warm",
    "days": 75,
    "yield_lb_per_sqft": 0.7,
    "price_per_lb": 2.6,
    "cost_per_sqft": 1.5,
    "kc": 0.85,
    "n_demand": "med",
    "ph": [
      6,
      6.8
    ],
    "gdd50": 1300,
    "max_plantings": 1
  },
  {
    "id": "zucchini",
    "name": "Zucchini",
    "season": "warm",
    "days": 50,
    "yield_lb_per_sqft": 1.5,
    "price_per_lb": 1.9,
    "cost_per_sqft": 0.15,
    "kc": 0.8,
    "n_demand": "med",
    "ph": [
      6,
      7.5
    ],
    "gdd50": 750,
    "max_plantings": 1
  },
  {
    "id": "cucumber",
    "name": "Cucumbers (trellised)",
    "season": "warm",
    "days": 55,
    "yield_lb_per_sqft": 1.5,
    "price_per_lb": 1.6,
    "cost_per_sqft": 0.1,
    "kc": 0.85,
    "n_demand": "med",
    "ph": [
      6,
      7
    ],
    "gdd50": 800,
    "max_plantings": 2
  },
  {
    "id": "bush_bean",
    "name": "Green beans (bush)",
    "season": "warm",
    "days": 55,
    "yield_lb_per_sqft": 0.5,
    "price_per_lb": 2.9,
    "cost_per_sqft": 0.25,
    "kc": 0.8,
    "n_demand": "low",
    "ph": [
      6,
      7
    ],
    "gdd50": 1000,
    "max_plantings": 2
  },
  {
    "id": "sweet_corn",
    "name": "Sweet corn",
    "season": "warm",
    "days": 80,
    "yield_lb_per_sqft": 0.35,
    "price_per_lb": 1,
    "cost_per_sqft": 0.1,
    "kc": 0.9,
    "n_demand": "high",
    "ph": [
      6,
      6.8
    ],
    "gdd50": 1500,
    "max_plantings": 1
  },
  {
    "id": "basil",
    "name": "Basil",
    "season": "warm",
    "days": 30,
    "yield_lb_per_sqft": 0.4,
    "price_per_lb": 16,
    "cost_per_sqft": 0.5,
    "kc": 0.7,
    "n_demand": "med",
    "ph": [
      6,
      7
    ],
    "gdd50": 600,
    "max_plantings": 1
  },
  {
    "id": "lettuce",
    "name": "Lettuce (leaf)",
    "season": "cool",
    "days": 45,
    "yield_lb_per_sqft": 0.6,
    "price_per_lb": 2.75,
    "cost_per_sqft": 0.1,
    "kc": 0.9,
    "n_demand": "med",
    "ph": [
      6,
      7
    ],
    "max_plantings": 3
  },
  {
    "id": "spinach",
    "name": "Spinach",
    "season": "cool",
    "days": 40,
    "yield_lb_per_sqft": 0.4,
    "price_per_lb": 5,
    "cost_per_sqft": 0.1,
    "kc": 0.9,
    "n_demand": "high",
    "ph": [
      6.5,
      7.5
    ],
    "max_plantings": 2
  },
  {
    "id": "kale",
    "name": "Kale",
    "season": "cool",
    "days": 55,
    "yield_lb_per_sqft": 0.9,
    "price_per_lb": 3.5,
    "cost_per_sqft": 0.15,
    "kc": 0.9,
    "n_demand": "high",
    "ph": [
      6,
      7.5
    ],
    "max_plantings": 1
  },
  {
    "id": "chard",
    "name": "Swiss chard",
    "season": "cool",
    "days": 55,
    "yield_lb_per_sqft": 1,
    "price_per_lb": 3,
    "cost_per_sqft": 0.1,
    "kc": 0.9,
    "n_demand": "med",
    "ph": [
      6,
      7
    ],
    "max_plantings": 1
  },
  {
    "id": "snap_pea",
    "name": "Snap peas",
    "season": "cool",
    "days": 60,
    "yield_lb_per_sqft": 0.3,
    "price_per_lb": 4.5,
    "cost_per_sqft": 0.15,
    "kc": 0.85,
    "n_demand": "low",
    "ph": [
      6,
      7.5
    ],
    "max_plantings": 2
  },
  {
    "id": "carrot",
    "name": "Carrots",
    "season": "cool",
    "days": 70,
    "yield_lb_per_sqft": 1,
    "price_per_lb": 1.1,
    "cost_per_sqft": 0.1,
    "kc": 0.8,
    "n_demand": "low",
    "ph": [
      6,
      6.8
    ],
    "max_plantings": 2
  },
  {
    "id": "radish",
    "name": "Radishes",
    "season": "cool",
    "days": 28,
    "yield_lb_per_sqft": 0.4,
    "price_per_lb": 2.5,
    "cost_per_sqft": 0.05,
    "kc": 0.8,
    "n_demand": "low",
    "ph": [
      6,
      7
    ],
    "max_plantings": 4
  },
  {
    "id": "beet",
    "name": "Beets",
    "season": "cool",
    "days": 55,
    "yield_lb_per_sqft": 0.7,
    "price_per_lb": 1.8,
    "cost_per_sqft": 0.1,
    "kc": 0.8,
    "n_demand": "med",
    "ph": [
      6.2,
      7
    ],
    "max_plantings": 2
  },
  {
    "id": "onion",
    "name": "Onions",
    "season": "cool",
    "days": 110,
    "yield_lb_per_sqft": 0.8,
    "price_per_lb": 1.2,
    "cost_per_sqft": 0.3,
    "kc": 0.85,
    "n_demand": "med",
    "ph": [
      6,
      7
    ],
    "max_plantings": 1
  },
  {
    "id": "garlic",
    "name": "Garlic",
    "season": "cool",
    "days": 240,
    "yield_lb_per_sqft": 0.35,
    "price_per_lb": 6,
    "cost_per_sqft": 1,
    "kc": 0.8,
    "n_demand": "med",
    "ph": [
      6,
      7
    ],
    "max_plantings": 1,
    "overwinter": true
  },
  {
    "id": "potato",
    "name": "Potatoes",
    "season": "cool",
    "days": 90,
    "yield_lb_per_sqft": 1.2,
    "price_per_lb": 0.95,
    "cost_per_sqft": 0.4,
    "kc": 0.9,
    "n_demand": "med",
    "ph": [
      5,
      6
    ],
    "max_plantings": 1
  }
];

/** Common garden-center amendments. n/p/k are the label analysis (% N, % P2O5, % K2O). n_avail is the share of N available in the first season (organic sources release slowly). Prices are typical US garden-center bag prices; edit to match your store. */
export const FERTILIZERS = [
  {
    "id": "balanced_10_10_10",
    "name": "10-10-10 all-purpose",
    "n": 10,
    "p": 10,
    "k": 10,
    "n_avail": 1,
    "organic": false,
    "bag_lb": 40,
    "bag_price": 18
  },
  {
    "id": "urea",
    "name": "Urea 46-0-0",
    "n": 46,
    "p": 0,
    "k": 0,
    "n_avail": 1,
    "organic": false,
    "bag_lb": 10,
    "bag_price": 12
  },
  {
    "id": "triple_super",
    "name": "Triple superphosphate 0-45-0",
    "n": 0,
    "p": 45,
    "k": 0,
    "n_avail": 1,
    "organic": false,
    "bag_lb": 4,
    "bag_price": 11
  },
  {
    "id": "muriate_potash",
    "name": "Muriate of potash 0-0-60",
    "n": 0,
    "p": 0,
    "k": 60,
    "n_avail": 1,
    "organic": false,
    "bag_lb": 4,
    "bag_price": 10
  },
  {
    "id": "blood_meal",
    "name": "Blood meal 12-0-0",
    "n": 12,
    "p": 0,
    "k": 0,
    "n_avail": 0.8,
    "organic": true,
    "bag_lb": 3,
    "bag_price": 13
  },
  {
    "id": "feather_meal",
    "name": "Feather meal 12-0-0",
    "n": 12,
    "p": 0,
    "k": 0,
    "n_avail": 0.6,
    "organic": true,
    "bag_lb": 5,
    "bag_price": 15
  },
  {
    "id": "bone_meal",
    "name": "Bone meal 3-15-0",
    "n": 3,
    "p": 15,
    "k": 0,
    "n_avail": 0.5,
    "organic": true,
    "bag_lb": 4,
    "bag_price": 10
  },
  {
    "id": "sulfate_potash",
    "name": "Sulfate of potash 0-0-50",
    "n": 0,
    "p": 0,
    "k": 50,
    "n_avail": 1,
    "organic": true,
    "bag_lb": 6,
    "bag_price": 19
  },
  {
    "id": "garden_tone",
    "name": "Organic vegetable food 3-4-4",
    "n": 3,
    "p": 4,
    "k": 4,
    "n_avail": 0.6,
    "organic": true,
    "bag_lb": 8,
    "bag_price": 15
  },
  {
    "id": "composted_manure",
    "name": "Composted manure 1-1-1",
    "n": 1,
    "p": 1,
    "k": 1,
    "n_avail": 0.3,
    "organic": true,
    "bag_lb": 40,
    "bag_price": 7
  }
];

export const PH_PRODUCTS = {
  "lime": {
    "name": "Pelletized limestone",
    "bag_lb": 30,
    "bag_price": 9
  },
  "sulfur": {
    "name": "Elemental sulfur",
    "bag_lb": 5,
    "bag_price": 16
  }
};

export const COMPOST = {
  "name": "Bagged compost (1 cu ft)",
  "bag_cuft": 1,
  "bag_price": 7.5,
  "lb_per_cuft": 30,
  "n_pct": 1,
  "n_avail": 0.05
};
