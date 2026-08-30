import type { MapElement, PointElement, MovingPointElement, LineElement, PolygonElement } from '../types';

// ========== GeoJSON 类型 ==========

export interface GeoFeature {
  type: 'Feature';
  geometry: {
    type: 'Point' | 'LineString' | 'Polygon' | 'MultiPolygon';
    coordinates: number[] | number[][] | number[][][] | number[][][][];
  };
  properties: Record<string, unknown>;
}

export interface GeoJSONCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

// ========== 元素转 GeoJSON ==========

export function elementToFeature(element: MapElement): GeoFeature | null {
  switch (element.type) {
    case 'point':
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: element.coordinates },
        properties: {
          elementType: 'point',
          id: element.id,
          name: element.name,
          color: element.color,
          iconSize: element.iconSize,
          startFrame: element.startFrame,
          endFrame: element.endFrame,
        },
      };

    case 'moving_point':
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: element.path },
        properties: {
          elementType: 'moving_point',
          id: element.id,
          name: element.name,
          color: element.color,
        },
      };

    case 'line':
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: element.coordinates },
        properties: {
          elementType: 'line',
          id: element.id,
          name: element.name,
          lineColor: element.lineColor,
          lineWidth: element.lineWidth,
        },
      };

    case 'polygon':
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: element.coordinates },
        properties: {
          elementType: 'polygon',
          id: element.id,
          name: element.name,
          fillColor: element.fillColor,
          fillOpacity: element.fillOpacity,
        },
      };

    case 'connector':
    case 'arrow':
    case 'encirclement':
    case 'gathering':
    case 'military_symbol':
    case 'custom_icon':
      return null;

    default:
      return null;
  }
}

// ========== GeoJSON 转元素 ==========

export function featureToElement(feature: GeoFeature): MapElement | null {
  const props = feature.properties as Record<string, unknown>;
  const type = props.elementType as string;

  const id = (props.id as string) || generateRandomId();
  const name = (props.name as string) || '导入元素';
  const startFrame = (props.startFrame as number) || 0;
  const endFrame = (props.endFrame as number) || 3000;

  switch (type) {
    case 'point': {
      if (feature.geometry.type !== 'Point') return null;
      return {
        id,
        type: 'point',
        name,
        visible: true,
        locked: false,
        startFrame,
        endFrame,
        style: {},
        coordinates: feature.geometry.coordinates as [number, number],
        color: (props.color as string) || '#FF4444',
        iconSize: (props.iconSize as number) || 8,
      } as PointElement;
    }

    case 'moving_point': {
      if (feature.geometry.type !== 'LineString') return null;
      return {
        id,
        type: 'moving_point',
        name,
        visible: true,
        locked: false,
        startFrame,
        endFrame,
        style: {},
        path: feature.geometry.coordinates as [number, number][],
        pathProgress: [{ frame: startFrame, value: 0 }, { frame: endFrame, value: 1 }],
        color: (props.color as string) || '#FF6600',
      } as MovingPointElement;
    }

    case 'line': {
      if (feature.geometry.type !== 'LineString') return null;
      return {
        id,
        type: 'line',
        name,
        visible: true,
        locked: false,
        startFrame,
        endFrame,
        style: {},
        coordinates: feature.geometry.coordinates as [number, number][],
        drawProgress: [{ frame: startFrame, value: 0 }, { frame: endFrame, value: 1 }],
        lineColor: (props.lineColor as string) || '#FF0000',
        lineWidth: (props.lineWidth as number) || 3,
      } as LineElement;
    }

    case 'polygon': {
      if (feature.geometry.type !== 'Polygon') return null;
      return {
        id,
        type: 'polygon',
        name,
        visible: true,
        locked: false,
        startFrame,
        endFrame,
        style: {},
        coordinates: feature.geometry.coordinates as [number, number][][],
        fillColor: (props.fillColor as string) || '#FF0000',
        fillOpacity: (props.fillOpacity as number) || 0.3,
        strokeColor: (props.strokeColor as string) || '#FF0000',
        strokeWidth: 2,
      } as PolygonElement;
    }

    default:
      return null;
  }
}

// ========== GeoJSON 转换 ==========

export function elementsToGeoJSON(elements: MapElement[]): GeoJSONCollection {
  const features = elements
    .map(elementToFeature)
    .filter((f): f is GeoFeature => f !== null);
  return { type: 'FeatureCollection', features };
}

export function geoJSONToElements(geojson: GeoJSONCollection): MapElement[] {
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error('Invalid GeoJSON: expected a FeatureCollection');
  }
  return geojson.features
    .map(featureToElement)
    .filter((el): el is MapElement => el !== null);
}

// ========== 文件操作 ==========

export function downloadGeoJSON(elements: MapElement[], filename: string): void {
  const geojson = elementsToGeoJSON(elements);
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}

export function uploadGeoJSON(file: File): Promise<MapElement[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const geojson = JSON.parse(reader.result as string) as GeoJSONCollection;
        resolve(geoJSONToElements(geojson));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function generateRandomId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}
