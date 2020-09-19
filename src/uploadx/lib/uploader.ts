import { Ajax, AjaxRequestConfig, RequestCanceler } from './ajax';
import {
  Metadata,
  RequestHeaders,
  RequestOptions,
  ResponseBody,
  UploadAction,
  UploaderOptions,
  UploadState,
  UploadStatus,
  UploadxControlEvent
} from './interfaces';
import { store } from './store';
import { createHash, DynamicChunk, isNumber, unfunc } from './utils';

const actionToStatusMap: { [K in UploadAction]: UploadStatus } = {
  pause: 'paused',
  upload: 'queue',
  cancel: 'cancelled'
};

/**
 * Uploader Base Class
 */
export abstract class Uploader implements UploadState {
  name: string;
  readonly size: number;
  readonly uploadId: string;
  response: ResponseBody = null;
  responseStatus = 0;
  responseHeaders: Record<string, string> = {};
  progress!: number;
  remaining!: number;
  speed!: number;
  /** Custom headers */
  headers: RequestHeaders = {};
  /** Metadata Object */
  metadata: Metadata;
  /** Upload endpoint */
  endpoint = '/upload';
  /** Chunk size in bytes */
  chunkSize: number;
  /** Auth token/tokenGetter */
  token: UploadxControlEvent['token'];
  /** Byte offset within the whole file */
  offset? = 0;
  /** Set HttpRequest responseType */
  protected responseType?: 'json' | 'text';
  private readonly prerequest: (
    req: RequestOptions
  ) => Promise<RequestOptions> | RequestOptions | void;
  private startTime!: number;
  private canceler = new RequestCanceler();
  retryAttempts = 0;

  private _url = '';

  get url(): string {
    return this._url || store.get(this.uploadId) || '';
  }

  set url(value: string) {
    this._url !== value && store.set(this.uploadId, value);
    this._url = value;
  }

  private _status!: UploadStatus;

  get status(): UploadStatus {
    return this._status;
  }

  set status(s: UploadStatus) {
    if (this._status === 'cancelled' || (this._status === 'complete' && s !== 'cancelled')) {
      return;
    }
    if (s !== this._status) {
      this.status === 'retry' && this.retryCancel();
      this._status = s;
      s === 'paused' && this.abort();
      ['cancelled', 'complete', 'error'].indexOf(s) !== -1 && this.cleanup();
      s === 'cancelled' ? this.cancel() : this.stateChange(this);
    }
  }

  constructor(
    readonly file: File,
    readonly options: Readonly<UploaderOptions>,
    readonly stateChange: (evt: UploadState) => void,
    readonly ajax: Ajax
  ) {
    this.name = file.name;
    this.size = file.size;
    this.metadata = {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      lastModified:
        file.lastModified || (file as File & { lastModifiedDate: Date }).lastModifiedDate.getTime()
    };
    const print = JSON.stringify({
      ...this.metadata,
      type: this.constructor.name,
      endpoint: options.endpoint
    });
    this.uploadId = createHash(print).toString(16);
    this.prerequest = options.prerequest || (() => {});
    this.chunkSize = options.chunkSize || this.size;
    this.configure(options);
  }

  /**
   * Configure uploader
   */
  configure({ metadata, headers, token, endpoint, action }: UploadxControlEvent): void {
    endpoint && (this.endpoint = endpoint);
    token && (this.token = token);
    metadata && Object.assign(this.metadata, unfunc(metadata, this.file));
    headers && Object.assign(this.headers, unfunc(headers, this.file));
    action && (this.status = actionToStatusMap[action]);
  }

  /**
   * Starts uploading
   */
  async upload(): Promise<void> {
    this.status = 'uploading';
    this.startTime = new Date().getTime();
    while ((this.offset || 0) < this.size) {
      this.url = this.url || (await this.getFileUrl());
      this.offset = isNumber(this.offset) ? await this.sendFileContent() : await this.getOffset();
      this.retryAttempts = 0;
    }
    this.remaining = 0;
    this.progress = 100;
    this.status = 'complete';
  }

  /**
   * Performs http requests
   */
  async request(
    requestOptions: RequestOptions
  ): Promise<{ data: string; status: number; headers: Record<string, string> }> {
    const { body = null, headers = {}, method, progress, url = this.url } =
      (await this.prerequest(requestOptions)) || requestOptions;
    const onUploadProgress =
      body && (body instanceof Blob || progress) ? this.onProgress() : undefined;
    const opts: AjaxRequestConfig = {
      method,
      headers: { ...this.headers, ...headers },
      url,
      data: body,
      responseType: this.responseType || undefined,
      onUploadProgress,
      canceler: this.canceler,
      withCredentials: !!this.options.withCredentials,
      validateStatus: code => code < 400
    };
    this.responseStatus = 0;
    this.response = null;
    this.responseHeaders = {};
    const response = await this.ajax.request(opts);
    this.response = response.data;
    this.responseHeaders = response.headers;
    this.responseStatus = response.status;
    return response;
  }

  /**
   * Set auth token
   */
  updateToken = async (): Promise<string | void> => {
    if (this.token) {
      this.setAuth(await unfunc(this.token, this.responseStatus));
    }
  };

  /**
   * Get file URI
   */
  protected abstract getFileUrl(): Promise<string>;

  /**
   * Send file content and return an offset for the next request
   */
  protected abstract sendFileContent(): Promise<number | undefined>;

  /**
   * Get an offset for the next request
   */
  protected abstract getOffset(): Promise<number | undefined>;

  protected setAuth(token: string): void {
    this.headers.Authorization = `Bearer ${token}`;
  }

  protected abort(): void {
    this.offset = undefined;
    this.canceler.cancel();
  }

  protected async cancel(): Promise<void> {
    this.abort();
    if (this.url) {
      await this.request({ method: 'DELETE' }).catch(() => {});
    }
    this.stateChange(this);
  }

  /**
   * Gets the value from the response
   */
  protected getValueFromResponse(key: string): string | null {
    return this.responseHeaders[key.toLowerCase()] || null;
  }

  protected getChunk(): { start: number; end: number; body: Blob } {
    this.chunkSize = isNumber(this.options.chunkSize) ? this.chunkSize : DynamicChunk.size;
    const start = this.offset || 0;
    const end = Math.min(start + this.chunkSize, this.size);
    const body = this.file.slice(this.offset, end);
    return { start, end, body };
  }

  private cleanup = () => store.delete(this.uploadId);

  retryCancel: () => void = () => {};

  private onProgress(): (evt: ProgressEvent) => void {
    let throttle = 0;
    return ({ loaded }) => {
      const now = new Date().getTime();
      const uploaded = (this.offset as number) + loaded;
      const elapsedTime = (now - this.startTime) / 1000;
      this.speed = Math.round(uploaded / elapsedTime);
      DynamicChunk.scale(this.speed);
      if (!throttle) {
        throttle = window.setTimeout(() => (throttle = 0), 500);
        this.progress = +((uploaded / this.size) * 100).toFixed(2);
        this.remaining = Math.ceil((this.size - uploaded) / this.speed);
        this.stateChange(this);
      }
    };
  }
}
