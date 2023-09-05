import { Storage } from '@google-cloud/storage';
import axios from 'axios';
import { createClient } from 'contentful-management';
import { Probot } from "probot";
import { loadFront } from 'yaml-front-matter';

import { createLinkObject } from './utils/createLinkObject';
import { Meta, Tag } from './types/md';
import { isAllowedImage } from './types/isImage';

export = (app: Probot) => {

  const client = createClient({
    accessToken: String(process.env.CONTENTFUL_MANAGEMENT_API_ACCESS_TOKEN)
  });

  app.on("push", async (context) => {
    const owner = context.payload.repository.owner.name;
    const repo = context.payload.repository.name;

    // コミット一覧を取得
    const commits = context.payload.commits;

    // 追加と更新のファイルパス取得
    const addFilePaths = commits.map((item) => item.added).flat();
    const modFilePaths = commits.map((item) => item.modified).flat();

    // 追加:mdのファイルたちを取得する
    const tmpMdlistAdds = [...addFilePaths].filter((item) => item.split('.').pop() === 'md');
    // 追加:mdじゃないファイルを取得する
    const tmpImagelistAdds = [...addFilePaths].filter((item) => item.split('.').pop() !== 'md' && isAllowedImage(String(item.split('.').pop())));
    // 更新:mdのファイルたちを取得する
    const tmpMdlistMods = [...modFilePaths ].filter((item) => item.split('.').pop() === 'md');
    // 更新:mdじゃないファイルを取得する
    const tmpImagelistMods = [...modFilePaths ].filter((item) => item.split('.').pop() !== 'md' && isAllowedImage(String(item.split('.').pop())));

    // articlesフォルダ配下のみ取得する
    const mdlistAdds = tmpMdlistAdds.filter((item) => item.startsWith('articles/'))
    const imagelistAdds = tmpImagelistAdds.filter((item) => item.startsWith('images/'))
    const mdlistMods = tmpMdlistMods.filter((item) => item.startsWith('articles/'))
    const imagelistMods = tmpImagelistMods.filter((item) => item.startsWith('images/'))

    // 追加:画像取得(全部)
    const imagesAdds = await Promise.all(imagelistAdds.map(async (item) => {
      return await context.octokit.repos.getContent({
        owner: String(owner),
        repo: repo,
        path: item,
        headers: {
          accept: 'application/vnd.github+json'
        },
      }).then(({data}) => data);
    }));

    // 追加:画像アップロード
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    imagesAdds.map(async (item : any) => {
      const image = await axios.get(item.download_url, {responseType: 'arraybuffer'});

      (async () => {
        const storage = new Storage({projectId: process.env.GCP_PROJECT_ID, keyFilename: process.env.GCS_KEY_PATH});
      
        await storage.bucket(String(process.env.GCS_NAME)).file(`${item.path}`).save(Buffer.from(image.data));

      })().catch(async (e) => {
        console.log(e.code, e.errors);
      });
    });

    // 更新:画像取得(全部)
    const imagesMods = await Promise.all(imagelistMods.map(async (item) => {
      return await context.octokit.repos.getContent({
        owner: String(owner),
        repo: repo,
        path: item,
        headers: {
          accept: 'application/vnd.github+json'
        },
      }).then(({data}) => data);
    }));

    // 更新:画像アップロード
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    imagesMods.map(async (item : any) => {
      const image = await axios.get(item.download_url, {responseType: 'arraybuffer'});
      
      (async () => {
        const storage = new Storage({projectId: process.env.GCP_PROJECT_ID, keyFilename: process.env.GCS_KEY_PATH});
        await storage.bucket(String(process.env.GCS_NAME)).file(`${item.path}`).save(Buffer.from(image.data));

      })().catch(async (e) => {
        console.log(e.code, e.errors);
      });
    });

    // 追加:記事取得(全部)
    const articleAdds = await Promise.all(mdlistAdds.map(async (item) => {
      return await context.octokit.repos.getContent({
        owner: String(owner),
        repo: repo,
        path: item,
        headers: {
          accept: 'application/vnd.github+json'
        },
      }).then(({data}) => data);
    }));

    // 追加:記事登録
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    articleAdds.map(async (item : any) => {
      const md = Buffer.from(item.content, 'base64').toString();
      const mdMeta = loadFront(md, {
        contentKeyName: 'entry'
      }) as unknown as Meta;

      // DB登録
      (async () => {
        // スペースを取得する。
        const space = await client.getSpace(String(process.env.CONTENTFUL_SPACE_ID));
        // 環境を取得する。
        const environment = await space.getEnvironment(String(process.env.CONTENTFUL_ENVIRONMENT));
    
        // タグ取得
        const tags: Tag[] = (await environment.getEntries({content_type: 'tags'})).items.map((item) => (
          {
            id: item.sys.id,
            name: item.fields.name['en-US']
          }));
        // Contentfulにあるタグの名前だけ
        const allTagName = tags.map((item) => item.name);

        // 存在するタグだけ
        const existTags = tags.filter((item) => mdMeta.tagNames.indexOf(item.name) !== -1);
        const unexistTags = mdMeta.tagNames.filter((item) => allTagName.indexOf(item) === -1);

        const addTagRes = await Promise.all(unexistTags.map(async (item) => {
        // ドラフトでエントリーを作成する。
          const draftEntry = await environment.createEntry('tags', {
            fields: {
              name: {
                'en-US': item
              },
              slug: {
                'en-US': item
              },
            }
          });
      
          const publishedEntry = await draftEntry.publish();
          console.log(`POST:${publishedEntry.sys.id} を更新しました。`);

          return ({
            id: publishedEntry.sys.id,
            name: item
          });
        }));

        const EntryTags = [...existTags, ...addTagRes];

        // ドラフトでエントリーを作成する。
        const draftEntry = await environment.createEntry('posts', {
          fields: {
            title: {
              'en-US': mdMeta.title
            },
            content: {
              'en-US': mdMeta.entry
            },
            slug: {
              'en-US': mdMeta.slug
            },
            tags:{
              'en-US': createLinkObject(EntryTags)
            }
          }
        });
    
        if (mdMeta.published) {
          const pubent = await draftEntry.publish();
          console.log(`POST:${pubent.sys.id} を作成しました。`);
        }
      })();
    });

    // 更新:記事取得(全部)
    const articleMods = await Promise.all(mdlistMods.map(async (item) => {
      return await context.octokit.repos.getContent({
        owner: String(owner),
        repo: repo,
        path: item,
        headers: {
          accept: 'application/vnd.github+json'
        },
      }).then(({data}) => data);
    }));

    // 更新:登録
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    articleMods.map(async (item : any) => {
      const md = Buffer.from(item.content, 'base64').toString();
      const mdMeta = loadFront(md, {
        contentKeyName: 'entry'
      }) as unknown as Meta;

      (async () => {
        // スペースを取得する。
        const space = await client.getSpace(String(process.env.CONTENTFUL_SPACE_ID));
    
        // 環境を取得する。
        const environment = await space.getEnvironment(String(process.env.CONTENTFUL_ENVIRONMENT));

        // 更新する記事のID取得
        const updatingPostId = (await environment.getEntries({content_type: 'posts', "fields.slug": `${mdMeta.slug}`})).items[0].sys.id;
        const updateEntryPost = await environment.getEntry(updatingPostId);

        // タグ取得
        const tags: Tag[] = (await environment.getEntries({content_type: 'tags'})).items.map((item) => (
          {
            id: item.sys.id,
            name: item.fields.name['en-US']
          }));
        // Contentfulにあるタグの名前だけ
        const allTagName = tags.map((item) => item.name);

        // 存在するタグだけ
        const existTags = tags.filter((item) => mdMeta.tagNames.indexOf(item.name) !== -1);
        const unexistTags = mdMeta.tagNames.filter((item) => allTagName.indexOf(item) === -1);

        const addTagRes = await Promise.all(unexistTags.map(async (item) => {
        // ドラフトでエントリーを作成する。
          const draftEntry = await environment.createEntry('tags', {
            fields: {
              name: {
                'en-US': item
              },
              slug: {
                'en-US': item
              },
            }
          });
      
          const publishedEntry = await draftEntry.publish();
          console.log(`TAG:${publishedEntry.sys.id} を作成しました。`);

          return ({
            id: publishedEntry.sys.id,
            name: item
          });
        }));

        const EntryTags = [...existTags, ...addTagRes];

        // 更新作業
        updateEntryPost.fields.title = { 'en-US': mdMeta.title };
        updateEntryPost.fields.content = { 'en-US': mdMeta.entry };
        updateEntryPost.fields.tags = { 'en-US': createLinkObject(EntryTags) };
        const resUpdate =  await updateEntryPost.update();

        if (mdMeta.published) {
          const pubent = await resUpdate.publish();
          console.log(`POST:${pubent.sys.id} を更新しました`);
        }

      })();
    });

  });
};
