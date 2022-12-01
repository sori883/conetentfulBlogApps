import { Tag } from '../types/md';

export function createLinkObject(tags: Tag[]) {
  const object = tags.map((item) => {
    const link = `{
          "sys": {
              "type": "Link",
              "linkType": "Entry",
              "id": "${item.id}"
          }
        }`;
    return JSON.parse(link);
  });
  return object;
}