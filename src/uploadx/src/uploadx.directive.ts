import {
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnInit,
  Output,
  Renderer2
} from '@angular/core';
import { UploadxControlEvent, UploadxOptions } from './interfaces';
import { UploadxService } from './uploadx.service';

@Directive({
  selector: '[uploadx]'
})
export class UploadxDirective implements OnInit {
  listenerFn: () => void;
  @Output()
  uploadxState = new EventEmitter();
  @Input()
  uploadx: UploadxOptions;
  @Input()
  set uploadxAction(ctrlEvent: UploadxControlEvent) {
    if (ctrlEvent && this.uploadService) {
      this.uploadService.control(ctrlEvent);
    }
  }
  constructor(
    private elementRef: ElementRef,
    private renderer: Renderer2,
    private uploadService: UploadxService
  ) {}

  ngOnInit() {
    if (!this.uploadx || this.uploadx.multiple !== false) {
      this.renderer.setAttribute(this.elementRef.nativeElement, 'multiple', '');
    }

    if (this.uploadx && this.uploadx.allowedTypes) {
      this.renderer.setAttribute(
        this.elementRef.nativeElement,
        'accept',
        this.uploadx.allowedTypes
      );
    }

    this.uploadxState.emit(this.uploadService.events);
  }

  @HostListener('change', ['$event.target.files'])
  fileListener(files: FileList) {
    if (files && files.item(0)) {
      this.uploadService.handleFileList(files, this.uploadx);
    }
  }
}
