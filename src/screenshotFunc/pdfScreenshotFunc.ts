// Monkey patch Path2D to avoid PDF.js crashing
(globalThis as any).Path2D = class {
  constructor(_path?: string) {}
  rect(_x: number, _y: number, _width: number, _height: number) {}
  addPath(_path: any, _transform?: any) {}
};

import _ from 'lodash';
import  { getDocument, PDFPageProxy } from 'pdfjs-dist';
import fs from 'fs';
import { Canvas, createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { consoleLogger, silentLogger } from '../logs.js';
import { TransformedRuleObject } from '../crawlers/pdfScanFunc.js';
import { IBboxLocation, StructureTree, ViewportSize } from '../types/types.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// CONSTANTS
const BBOX_PADDING = 50;

// Interfaces
interface pathObject {
  pageIndex?: number;
  contentStream?: number;
  content?: number;
  contentItems?: number[];
  mcid?: number;
  annot?: number;
}

// Use safe canvas to avoid Path2D issues
function createSafeCanvas(width: number, height: number) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Patch clip/stroke/fill/etc. to skip if Path2D is passed
  const wrapIgnorePath2D = (fn: Function) =>
    function (...args: any[]) {
      if (args.length > 0 && args[0] instanceof (globalThis as any).Path2D) {
        // Skip the operation
        return;
      }
      return fn.apply(this, args);
    };

  ctx.clip = wrapIgnorePath2D(ctx.clip);
  ctx.fill = wrapIgnorePath2D(ctx.fill);
  ctx.stroke = wrapIgnorePath2D(ctx.stroke);
  ctx.isPointInPath = wrapIgnorePath2D(ctx.isPointInPath);
  ctx.isPointInStroke = wrapIgnorePath2D(ctx.isPointInStroke);

  return canvas;
}

// CanvasFactory for Node.js
function NodeCanvasFactory() {}
NodeCanvasFactory.prototype = {
  create: function NodeCanvasFactory_create(width: number, height: number) {
    assert(width > 0 && height > 0, 'Invalid canvas size');
    const canvas = createSafeCanvas(width, height);
    const context = canvas.getContext('2d');
    return {
      canvas,
      context,
    };
  },

  reset: function NodeCanvasFactory_reset(
    canvasAndContext: { canvas: Canvas; context: SKRSContext2D },
    width: number,
    height: number,
  ) {
    assert(canvasAndContext.canvas, 'Canvas is not specified');
    assert(width > 0 && height > 0, 'Invalid canvas size');
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  },

  destroy: function NodeCanvasFactory_destroy(canvasAndContext: {
    canvas: Canvas;
    context: SKRSContext2D;
  }) {
    assert(canvasAndContext.canvas, 'Canvas is not specified');

    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  },
};

const canvasFactory = new NodeCanvasFactory();

export async function getPdfScreenshots(
  pdfFilePath: string,
  items: TransformedRuleObject['items'],
  screenshotPath: string,
) {
  const newItems = _.cloneDeep(items);
  const loadingTask = getDocument({
    url: pdfFilePath,
    canvasFactory,
    standardFontDataUrl: path.join(dirname, '../node_modules/pdfjs-dist/standard_fonts/'),
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  const structureTree = await pdf._pdfInfo.structureTree;

  // save some resources by caching page canvases to be reused by diff violations
  const pageCanvasCache = {};

  // iterate through each violation
  for (let i = 0; i < newItems.length; i++) {
    const { context } = newItems[i];
    const bbox: IBboxLocation = { location: context };
    const bboxMap = buildBboxMap([bbox], structureTree);

    for (const [pageNum, bboxList] of Object.entries(bboxMap)) {
      const page = await pdf.getPage(parseInt(pageNum, 10));

      // an array of length 1, containing location of current violation
      const bboxesWithCoords = await Promise.all([
        page.getOperatorList(),
        page.getAnnotations(),
      ]).then(getBboxesList(bboxList, page));

      // Render the page on a Node canvas with 200% scale.
      const viewport = page.getViewport({ scale: 2.0 });

      const canvasAndContext =
        pageCanvasCache[pageNum] ?? canvasFactory.create(viewport.width, viewport.height);
      if (!pageCanvasCache[pageNum]) {
        pageCanvasCache[pageNum] = canvasAndContext;
      }
      const { canvas: origCanvas, context: origCtx } = canvasAndContext;

      const renderContext = {
        canvasContext: origCtx,
        viewport,
        canvasFactory,
      };
      const renderTask = page.render(renderContext); // render pdf page onto a canvas
      await renderTask.promise;

      const finalScreenshotPath = annotateAndSave(
        origCanvas,
        screenshotPath,
        viewport,
      )(bboxesWithCoords[0]);

      newItems[i].screenshotPath = path.join('elemScreenshots', 'pdf', finalScreenshotPath);
      newItems[i].page = parseInt(pageNum, 10);

      page.cleanup();
    }
  }
  return newItems;
}

const annotateAndSave = (origCanvas: Canvas, screenshotPath: string, viewport: ViewportSize) => {
  return ({ location }) => {
    const [left, bottom, width, height] = location.map(loc => loc * 2); // scale up by 2
    const rectParams = [left, viewport.height - bottom - height, width, height];

    // create new canvas to annotate so we do not "pollute" the original
    const { context: highlightCtx, canvas: highlightCanvas } = canvasFactory.create(
      viewport.width,
      viewport.height,
    );

    highlightCtx.drawImage(origCanvas, 0, 0);
    highlightCtx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    highlightCtx.fillRect(...rectParams);

    const rectParamsWithPadding = [
      left - BBOX_PADDING,
      viewport.height - bottom - height - BBOX_PADDING,
      width + BBOX_PADDING * 2,
      height + BBOX_PADDING * 2,
    ];

    // create new canvas to crop image
    const { context: croppedCtx, canvas: croppedCanvas } = canvasFactory.create(
      rectParamsWithPadding[2],
      rectParamsWithPadding[3],
    );

    croppedCtx.drawImage(
      highlightCanvas,
      ...rectParamsWithPadding,
      0,
      0,
      rectParamsWithPadding[2],
      rectParamsWithPadding[3],
    );

    // convert the canvas to an image
    // const croppedImage = croppedCanvas.toBuffer();
    const croppedImage = croppedCanvas.toBuffer('image/png');

    // save image
    let counter = 0;
    let indexedScreenshotPath = `${screenshotPath}-${counter}.png`;
    let fileExists = fs.existsSync(indexedScreenshotPath);
    while (fileExists) {
      counter++;
      indexedScreenshotPath = `${screenshotPath}-${counter}.png`;
      fileExists = fs.existsSync(indexedScreenshotPath);
    }
    try {
      fs.writeFileSync(indexedScreenshotPath, croppedImage);
    } catch (e) {
      consoleLogger.error('Error in writing screenshot:', e);
    }

    canvasFactory.destroy({ canvas: croppedCanvas, context: croppedCtx });
    canvasFactory.destroy({ canvas: highlightCanvas, context: highlightCtx });

    return path.basename(indexedScreenshotPath);
  };
};

export const rotateViewport = (rotateAngle, viewport) => {
  if ([0, 180].includes(rotateAngle)) {
    return viewport;
  }
  return [viewport[1], viewport[0], viewport[3], viewport[2]];
};

export const rotatePoint = (rotateAngle, point, viewport) => {
  const rad = (rotateAngle * Math.PI) / 180;
  let x = point[0] * Math.cos(rad) + point[1] * Math.sin(rad);
  let y = -point[0] * Math.sin(rad) + point[1] * Math.cos(rad);
  switch (rotateAngle) {
    case 90:
      y += viewport[2] + viewport[0];
      break;
    case 180:
      x += viewport[2] + viewport[0];
      y += viewport[3] + viewport[1];
      break;
    case 270:
      x += viewport[3] + viewport[1];
      break;
    default:
      break;
  }
  return [x, y];
};

export const rotateCoordinates = (coords, rotateAngle, viewport) => {
  if (rotateAngle === 0) return coords;
  const [x1, y1] = rotatePoint(rotateAngle, [coords[0], coords[1]], viewport);
  const [x2, y2] = rotatePoint(
    rotateAngle,
    [coords[0] + coords[2], coords[1] + coords[3]],
    viewport,
  );
  return [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x1 - x2), Math.abs(y1 - y2)];
};

function concatBoundingBoxes(newBoundingBox, oldBoundingBox) {
  if (_.isNil(oldBoundingBox) && _.isNil(newBoundingBox)) {
    return {};
  }

  if (_.isNil(newBoundingBox)) {
    return oldBoundingBox || {};
  }
  if (_.isNil(oldBoundingBox)) {
    return _.cloneDeep(newBoundingBox);
  }
  return {
    x: Math.min(newBoundingBox.x, oldBoundingBox.x),
    y: Math.min(newBoundingBox.y, oldBoundingBox.y),
    width:
      Math.max(newBoundingBox.x + newBoundingBox.width, oldBoundingBox.x + oldBoundingBox.width) -
      Math.min(newBoundingBox.x, oldBoundingBox.x),
    height:
      Math.max(newBoundingBox.y + newBoundingBox.height, oldBoundingBox.y + oldBoundingBox.height) -
      Math.min(newBoundingBox.y, oldBoundingBox.y),
  };
}

export const parseMcidToBbox = (listOfMcid, pageMap, annotations, viewport, rotateAngle) => {
  type coordsObject = {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  let coords: coordsObject = { x: undefined, y: undefined, width: undefined, height: undefined };

  if (listOfMcid instanceof Array) {
    listOfMcid.forEach(mcid => {
      const currentBbox = pageMap[mcid];
      if (
        !_.isNil(currentBbox) &&
        !_.isNaN(currentBbox.x) &&
        !_.isNaN(currentBbox.y) &&
        !_.isNaN(currentBbox.width) &&
        !_.isNaN(currentBbox.height)
      ) {
        coords = concatBoundingBoxes(currentBbox, coords.x ? coords : undefined);
      }
    });
  } else if (Object.prototype.hasOwnProperty.call(listOfMcid, 'annot')) {
    const rect = annotations[listOfMcid.annot]?.rect;
    if (rect) {
      coords = {
        x: rect[0],
        y: rect[1],
        width: Math.abs(rect[0] - rect[2]),
        height: Math.abs(rect[1] - rect[3]),
      };
    }
  }
  if (!coords) return [];
  const coordsArray = rotateCoordinates(
    [coords.x, coords.y, coords.width, coords.height],
    rotateAngle,
    viewport,
  );
  const rotatedViewport = rotateViewport(rotateAngle, viewport);
  return [
    coordsArray[0] - rotatedViewport[0],
    coordsArray[1] - rotatedViewport[1],
    coordsArray[2],
    coordsArray[3],
  ];
};

export const getBboxForGlyph = (
  operatorIndex,
  glyphIndex,
  operationsList,
  viewport,
  rotateAngle,
) => {
  const bbox = operationsList[operatorIndex] ? operationsList[operatorIndex][glyphIndex] : null;
  if (!bbox) {
    return [];
  }
  const coordsArray = rotateCoordinates(bbox, rotateAngle, viewport);
  const rotatedViewport = rotateViewport(rotateAngle, viewport);
  return [
    coordsArray[0] - rotatedViewport[0],
    coordsArray[1] - rotatedViewport[1],
    coordsArray[2],
    coordsArray[3],
  ];
};

// Below are methods adapted from
// https://github.com/veraPDF/verapdf-js-viewer/blob/master/src/services/bboxService.ts
// to determine the bounding box data of the violations from the context field

export const getBboxesList = (bboxList, page: PDFPageProxy) => {
  return ([operatorList, annotations]) => {
    const operationData = operatorList.argsArray[operatorList.argsArray.length - 2];
    const [positionData, noMCIDData] = operatorList.argsArray[operatorList.argsArray.length - 1];
    const bboxes = bboxList.map(bbox => {
      if (bbox.mcidList) {
        bbox.location = parseMcidToBbox(
          bbox.mcidList,
          positionData,
          annotations,
          page.view,
          page.rotate,
        );
      } else if (bbox.contentItemPath) {
        const contentItemsPath = bbox.contentItemPath.slice(2);
        let contentItemsBBoxes = noMCIDData[bbox.contentItemPath[1]];
        try {
          contentItemsPath.forEach((ci, i) => {
            if (contentItemsPath.length > i + 1 || !contentItemsBBoxes.final) {
              contentItemsBBoxes = contentItemsBBoxes.contentItems[0];
            }
            contentItemsBBoxes = contentItemsBBoxes.contentItems[ci];
          });

          bbox.location = [
            contentItemsBBoxes.contentItem.x,
            contentItemsBBoxes.contentItem.y,
            contentItemsBBoxes.contentItem.w,
            contentItemsBBoxes.contentItem.h,
          ];
        } catch (err) {
          console.log('NoMCIDDataParseError:', err.message || err);
          bbox.location = [0, 0, 0, 0];
        }
      }
      if (_.isNumber(bbox.operatorIndex) && _.isNumber(bbox.glyphIndex)) {
        bbox.location = getBboxForGlyph(
          bbox.operatorIndex,
          bbox.glyphIndex,
          operationData,
          page.view,
          page.rotate,
        );
      }
      return bbox;
    });
    return bboxes;
  };
};

/*
 *  Going through object of tags from error placement and return array of its MCIDs
 *
 *  @param {Object} of tags
 *
 *  @return [[{Array}, {Number}]] - [[[array of mcids], page of error]]
 */
function findAllMcid(tagObject) {
  const mcidMap = {};

  function func(obj) {
    if (!obj) return;
    if (obj.mcid || obj.mcid === 0) {
      if (!mcidMap[obj.pageIndex]) mcidMap[obj.pageIndex] = [];
      mcidMap[obj.pageIndex].push(obj.mcid);
    }
    if (!obj.children) {
      return;
    }

    if (!(obj.children instanceof Array)) {
      func(obj.children);
    } else {
      [...obj.children].forEach(child => func(child));
    }
  }

  func(tagObject);
  return _.map(mcidMap, (value, key) => [value, _.toNumber(key)]);
}

/*
 *  Convert returning from veraPDF api path to error in array of nodes
 *
 *  @param errorContext {string} ugly path to error
 *
 *  @return arrayOfNodes {array} of nodes from Document to error Tag
 */
type Node = [number, string];
type ConvertContextToPathReturn = pathObject | Node[];

const convertContextToPath = (errorContext = ''): ConvertContextToPathReturn => {
  let arrayOfNodes: Node[] = [];
  if (!errorContext) {
    return arrayOfNodes;
  }

  const contextString = errorContext;

  try {
    if (contextString.includes('contentItem') && !contextString.includes('mcid')) {
      const result = contextString.match(
        /pages\[(?<pages>\d+)\](\(.+\))?\/contentStream\[(?<contentStream>\d+)\](\(.+\))?\/content\[(?<content>\d+)\](?<contentItems>((\(.+\))?\/contentItem\[(\d+)\])+)/,
      );
      if (result) {
        try {
          let path: pathObject;
          path.pageIndex = parseInt(result.groups.pages, 10);
          path.contentStream = parseInt(result.groups.contentStream, 10);
          path.content = parseInt(result.groups.content, 10);
          path.contentItems = result.groups.contentItems
            .split('/')
            .filter(ci => ci.includes('contentItem'))
            .map(ci => {
              const contentItemIndex = ci.match(/\[(?<contentItem>\d+)\]/);
              return parseInt(contentItemIndex?.groups?.contentItem || '-1', 10);
            });
          return path;
        } catch (err) {
          console.log('NoMCIDContentItemPathParseError:', err.message || err);
        }
      }
    }

    if (contextString.includes('contentItem')) {
      let path: pathObject;
      contextString.split('/').forEach(nodeString => {
        if (nodeString.includes('page')) {
          path.pageIndex = parseInt(nodeString.split(/[[\]]/)[1], 10);
        } else if (nodeString.includes('contentItem') && nodeString.includes('mcid')) {
          path.mcid = parseInt(nodeString.split('mcid:')[1].slice(0, -1), 10);
        }
      });
      return path;
    }
    if (contextString.includes('annots')) {
      let path: pathObject;
      contextString.split('/').forEach(nodeString => {
        if (nodeString.includes('page')) {
          path.pageIndex = parseInt(nodeString.split(/[[\]]/)[1], 10);
        } else if (nodeString.includes('annots')) {
          path.annot = parseInt(nodeString.split(/[[\]]/)[1], 10);
        }
      });
      return path;
    }

    const contextStringArray: string[] = contextString.split('PDStructTreeRoot)/')[1].split('/'); // cut path before start of Document
    contextStringArray.forEach(nodeString => {
      const nextIndex = parseInt(nodeString.split('](')[0].split('K[')[1], 10);
      let nextTag: string | string[] = nodeString.split('(')[1].split(')')[0].split(' ');
      nextTag = nextTag[nextTag.length - 1];

      arrayOfNodes = [...arrayOfNodes, [nextIndex, nextTag]];
    });
    return arrayOfNodes;
  } catch {
    return [];
  }
};

const getTagsFromErrorPlace = (context: string, structure: StructureTree) => {
  const defaultValue = [[[], -1, undefined]];
  const selectedTag = convertContextToPath(context);

  if (_.isEmpty(selectedTag)) {
    return defaultValue;
  }
  // Type guard function
  function isPathObject(value: any): value is pathObject {
    return (
      value !== null &&
      typeof value === 'object' &&
      (Object.prototype.hasOwnProperty.call(value, 'mcid') ||
        Object.prototype.hasOwnProperty.call(value, 'pageIndex') ||
        Object.prototype.hasOwnProperty.call(value, 'annot') ||
        Object.prototype.hasOwnProperty.call(value, 'contentItems'))
    );
  }

  if (isPathObject(selectedTag)) {
    if (
      Object.prototype.hasOwnProperty.call(selectedTag, 'mcid') &&
      Object.prototype.hasOwnProperty.call(selectedTag, 'pageIndex')
    ) {
      return [[[selectedTag.mcid], selectedTag.pageIndex]];
    }
    if (
      Object.prototype.hasOwnProperty.call(selectedTag, 'annot') &&
      Object.prototype.hasOwnProperty.call(selectedTag, 'pageIndex')
    ) {
      return [[{ annot: selectedTag.annot }, selectedTag.pageIndex]];
    }
    if (Object.prototype.hasOwnProperty.call(selectedTag, 'contentItems')) {
      return [
        [
          undefined,
          selectedTag.pageIndex,
          [selectedTag.contentStream, selectedTag.content, ...selectedTag.contentItems],
        ],
      ];
    }
  } else if (selectedTag instanceof Array) {
    let objectOfErrors = { ...structure };
    selectedTag.forEach((node, index) => {
      let nextStepObject;
      if (!objectOfErrors.children) {
        nextStepObject = objectOfErrors[node[0]];
      } else if (!(objectOfErrors.children instanceof Array)) {
        if (objectOfErrors.children.name === node[1]) {
          nextStepObject = objectOfErrors.children;
        } else {
          nextStepObject = objectOfErrors;
        }
      } else if (objectOfErrors?.name === node[1] && index === 0) {
        nextStepObject = objectOfErrors;
      } else {
        const clearedChildrenArray = [...objectOfErrors.children].filter(tag => !tag?.mcid);
        nextStepObject = {
          ...(clearedChildrenArray.length ? clearedChildrenArray : objectOfErrors.children)[
            node[0]
          ],
        };
      }
      objectOfErrors = { ...nextStepObject };
    });
    return findAllMcid(objectOfErrors);
  }
  return defaultValue;
};

const calculateLocation = location => {
  const bboxes = [];
  const [pages, boundingBox] = location.split('/');
  const [start, end] = pages.replace('pages[', '').replace(']', '').split('-');
  const [x, y, x1, y1] = boundingBox.replace('boundingBox[', '').replace(']', '').split(',');
  const width = parseFloat(x1) - parseFloat(x);

  if (end) {
    for (let i = parseInt(start) + 1; i <= parseInt(end) + 1; i++) {
      switch (i) {
        case parseInt(start) + 1:
          bboxes.push({
            page: i,
            location: [parseFloat(x), parseFloat(y1), width, 'bottom'],
          });
          break;
        case parseInt(end) + 1:
          bboxes.push({
            page: i,
            location: [parseFloat(x), parseFloat(y), width, 'top'],
          });
          break;
        default:
          bboxes.push({
            page: i,
            location: [parseFloat(x), 0, width, 'top'],
          });
          break;
      }
    }
  } else {
    const height = parseFloat(y1) - parseFloat(y);
    bboxes.push({
      page: parseInt(start) + 1,
      location: [parseFloat(x), parseFloat(y), width, height],
    });
  }

  return bboxes;
};

const calculateLocationJSON = location => {
  const bboxes = [];
  const bboxMap = JSON.parse(location);

  bboxMap.bbox.forEach(({ p, rect }) => {
    const [x, y, x1, y1] = rect;
    const width = parseFloat(x1) - parseFloat(x);
    const height = parseFloat(y1) - parseFloat(y);
    bboxes.push({
      page: parseFloat(p) + 1,
      location: [parseFloat(x), parseFloat(y), width, height],
    });
  });
  return bboxes;
};

export const calculateLocationInStreamOperator = location => {
  const path = location.split('/');
  let pageIndex = -1;
  let operatorIndex = -1;
  let glyphIndex = -1;
  path.forEach(step => {
    if (step.startsWith('pages')) {
      pageIndex = parseInt(step.split(/[\[\]]/)[1]);
    }
    if (step.startsWith('operators')) {
      operatorIndex = parseInt(step.split(/[\[\]]/)[1]);
    }
    if (step.startsWith('usedGlyphs')) {
      glyphIndex = parseInt(step.split(/[\[\]]/)[1]);
    }
  });
  if (pageIndex === -1 || operatorIndex === -1 || glyphIndex === -1) {
    return null;
  }
  return {
    pageIndex,
    operatorIndex,
    glyphIndex,
  };
};

export const buildBboxMap = (bboxes: IBboxLocation[], structure: StructureTree) => {
  const bboxMap = {};
  bboxes.forEach((bbox, index) => {
    try {
      if (bbox.location.includes('contentStream') && bbox.location.includes('operators')) {
        const bboxPosition = calculateLocationInStreamOperator(bbox.location);
        if (!bboxPosition) {
          return;
        }
        bboxMap[bboxPosition.pageIndex + 1] = [
          ...(bboxMap[bboxPosition.pageIndex + 1] || []),
          {
            index,
            operatorIndex: bboxPosition.operatorIndex,
            glyphIndex: bboxPosition.glyphIndex,
            bboxTitle: bbox.bboxTitle,
          },
        ];
      } else if (
        bbox.location.includes('StructTreeRoot') ||
        bbox.location.includes('root/doc') ||
        bbox.location === 'root'
      ) {
        const mcidData = getTagsFromErrorPlace(bbox.location, structure);
        mcidData.forEach(([mcidList, pageIndex, contentItemPath]) => {
          bboxMap[pageIndex + 1] = [
            ...(bboxMap[pageIndex + 1] || []),
            {
              index,
              mcidList,
              contentItemPath,
              groupId: bbox.groupId || undefined,
              bboxTitle: bbox.bboxTitle,
            },
          ];
        });
      } else {
        const bboxesFromLocation = bbox.location.includes('pages[')
          ? calculateLocation(bbox.location)
          : calculateLocationJSON(bbox.location);
        bboxesFromLocation.forEach(bboxWithLocation => {
          bboxMap[bboxWithLocation.page] = [
            ...(bboxMap[bboxWithLocation.page] || []),
            {
              index,
              location: bboxWithLocation.location,
              groupId: bbox.groupId || undefined,
              bboxTitle: bbox.bboxTitle,
            },
          ];
        });
      }
    } catch {
      console.error(`Location not supported: ${bbox.location}`);
    }
  });
  return bboxMap;
};

export const getSelectedPageByLocation = bboxLocation => {
  const location = bboxLocation;
  const path = location.split('/');
  let pageNumber = -1;
  if (location?.includes('pages') && path[path.length - 1].startsWith('pages')) {
    location.split('/').forEach(nodeString => {
      if (nodeString.includes('pages')) {
        pageNumber = parseInt(nodeString.split(/[[\]]/)[1], 10) + 1;
      }
    });
  }
  return pageNumber;
};

export const getBboxPage = (bbox, structure) => {
  try {
    if (
      bbox.location.includes('StructTreeRoot') ||
      bbox.location.includes('root/doc') ||
      bbox.location === 'root'
    ) {
      const mcidData = getTagsFromErrorPlace(bbox.location, structure);
      const pageIndex = mcidData[0][1] as number;
      return pageIndex + 1;
    }
    const bboxesFromLocation = bbox.location.includes('pages[')
      ? calculateLocation(bbox.location)
      : calculateLocationJSON(bbox.location);
    return bboxesFromLocation.length ? bboxesFromLocation[0].page : 0;
  } catch (e) {
    console.error(e);
    console.error(`Location not supported: ${bbox.location}`);
    return -1;
  }
};

export const getPageFromContext = async (context: string, pdfFilePath: string): Promise<number> => {
  try {
    const loadingTask = getDocument({
      url: pdfFilePath,
      standardFontDataUrl: path.join(dirname, '../../node_modules/pdfjs-dist/standard_fonts/'),
      disableFontFace: true,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    const structureTree = await pdf._pdfInfo.structureTree;

    const page = getBboxPage({ location: context }, structureTree);
    return page;
  } catch {
    // Error handling
  }
};

export const getBboxPages = (bboxes, structure) => {
  return bboxes.map(bbox => {
    getBboxPage(bbox, structure);
  });
};
