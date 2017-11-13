import { RequiredApiVersionError } from '../errors';
import { RocketletManager } from '../RocketletManager';
import { ICompilerFile } from './ICompilerFile';
import { IParseZipResult } from './IParseZipResult';

import * as AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { IRocketletInfo } from 'temporary-rocketlets-ts-definition/metadata/IRocketletInfo';
import * as uuidv4 from 'uuid/v4';

export class RocketletPackageParser {
    // tslint:disable-next-line:max-line-length
    public static uuid4Regex: RegExp = /^[0-9a-fA-f]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    private allowedIconExts: Array<string> = ['.png', '.jpg', '.jpeg', '.gif'];
    private rocketletsTsDefVer: string;

    constructor(private readonly manager: RocketletManager) {
        this.rocketletsTsDefVer = this.getTsDefVersion();
    }

    public async parseZip(zipBase64: string): Promise<IParseZipResult> {
        const zip = new AdmZip(new Buffer(zipBase64, 'base64'));
        const infoZip = zip.getEntry('rocketlet.json');
        let info: IRocketletInfo;

        if (infoZip && !infoZip.isDirectory) {
            try {
                info = JSON.parse(infoZip.getData().toString()) as IRocketletInfo;

                if (!RocketletPackageParser.uuid4Regex.test(info.id)) {
                    info.id = uuidv4();
                    console.warn('WARNING: We automatically generated a uuid v4 id for',
                        info.name, 'since it did not provide us an id. This is NOT',
                        'recommended as the same Rocketlet can be installed several times.');
                }
            } catch (e) {
                throw new Error('Invalid Rocketlet package. The "rocketlet.json" file is not valid json.');
            }
        } else {
            throw new Error('Invalid Rocketlet package. No "rocketlet.json" file.');
        }

        if (!semver.satisfies(this.rocketletsTsDefVer, info.requiredApiVersion)) {
            throw new RequiredApiVersionError(info, this.rocketletsTsDefVer);
        }

        // Load all of the TypeScript only files
        const tsFiles: { [s: string]: ICompilerFile } = {};

        zip.getEntries().filter((entry) => entry.entryName.endsWith('.ts') && !entry.isDirectory).forEach((entry) => {
            const norm = path.normalize(entry.entryName);

            // Files which start with `.` are supposed to be hidden
            if (norm.startsWith('.')) {
                return;
            }

            tsFiles[norm] = {
                name: norm,
                content: entry.getData().toString(),
                version: 0,
            };
        });

        // Ensure that the main class file exists
        if (!tsFiles[path.normalize(info.classFile)]) {
            throw new Error(`Invalid Rocketlet package. Could not find the classFile (${info.classFile}) file.`);
        }

        const languageContent = this.getLanguageContent(zip);

        // Compile all the typescript files to javascript
        // this actually modifies the `tsFiles` object
        this.manager.getCompiler().toJs(info, tsFiles);

        const compiledFiles: { [s: string]: string } = {};
        Object.keys(tsFiles).forEach((name) => {
            const norm = path.normalize(name);
            compiledFiles[norm.replace(/\./g, '$')] = tsFiles[norm].compiled;
        });

        // Get the icon's content
        const iconFile = this.getIconFile(zip, info.iconFile);
        if (iconFile) {
            info.iconFileContent = iconFile;
        }

        return {
            info,
            compiledFiles,
            languageContent,
        };
    }

    private getLanguageContent(zip: AdmZip): { [key: string]: object } {
        const languageContent: { [key: string]: object } = {};

        zip.getEntries().filter((entry) =>
            !entry.isDirectory &&
            entry.entryName.startsWith('i18n/') &&
            entry.entryName.endsWith('.json'))
        .forEach((entry) => {
            const entrySplit = entry.entryName.split('/');
            const lang = entrySplit[entrySplit.length - 1].split('.')[0].toLowerCase();

            let content;
            try {
                content = JSON.parse(entry.getData().toString());
            } catch (e) {
                // Failed to parse it, maybe warn them? idk yet
            }

            languageContent[lang] = Object.assign(languageContent[lang] || {}, content);
        });

        return languageContent;
    }

    private getIconFile(zip: AdmZip, filePath: string): string {
        if (!filePath || !this.allowedIconExts.includes(path.extname(filePath))) {
            return undefined;
        }

        const entry = zip.getEntry(filePath);

        if (entry.isDirectory) {
            return undefined;
        }

        return entry.getData().toString('base64');
    }

    private getTsDefVersion(): string {
        const devLocation = 'node_modules/temporary-rocketlets-ts-definition/package.json';
        // tslint:disable-next-line
        const prodLocation = __dirname.split('temporary-rocketlets-server')[0] + 'temporary-rocketlets-ts-definition/package.json';

        if (fs.existsSync(devLocation)) {
            const info = JSON.parse(fs.readFileSync(devLocation, 'utf8'));
            return info.version as string;
        } else if (fs.existsSync(prodLocation)) {
            const info = JSON.parse(fs.readFileSync(prodLocation, 'utf8'));
            return info.version as string;
        } else {
            throw new Error('Could not find the Rocketlets TypeScript Definition Package Version!');
        }
    }
}
