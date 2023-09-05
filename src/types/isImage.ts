export const isAllowedImage = (value: string): boolean => {
  return [
    'jpg',
     'jpeg',
     'png',
     'gif',
     'bmp',
     'tiff',
     'tif',
     'webp',
     'ico',
  ].includes(value);

};