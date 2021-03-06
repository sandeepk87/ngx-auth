import { Injectable, Injector } from '@angular/core';
import {
  HttpClient,
  HttpEvent,
  HttpInterceptor,
  HttpHandler,
  HttpRequest,
  HttpErrorResponse
} from '@angular/common/http';
import { Subject, Observable, throwError } from 'rxjs';
import { map, first, switchMap, catchError } from 'rxjs/operators';

import { AuthService } from './auth.service';
import { AUTH_SERVICE } from './tokens';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {

  /**
   * Is refresh token is being executed
   */
  private refreshInProgress = false;

  /**
   * Notify all outstanding requests through this subject
   */
  private refreshSubject: Subject<boolean> = new Subject<boolean>();

  constructor(private injector: Injector) {}

  /**
   * Intercept an outgoing `HttpRequest`
   */
  public intercept(
    req: HttpRequest<any>,
    delegate: HttpHandler
  ): Observable<HttpEvent<any>> {
    if (this.skipRequest(req)) {
      return delegate.handle(req);
    }

    return this.processIntercept(req, delegate);
  }

  /**
   * Process all the requests via custom interceptors.
   */
  private processIntercept(
    original: HttpRequest<any>,
    delegate: HttpHandler
  ): Observable<HttpEvent<any>> {
    const clone: HttpRequest<any> = original.clone();

    return this.request(clone)
      .pipe(
        switchMap((req: HttpRequest<any>) => delegate.handle(req)),
        catchError((res: HttpErrorResponse) => this.responseError(clone, res))
      );
  }

  /**
   * Request interceptor. Delays request if refresh is in progress
   * otherwise adds token to the headers
   */
  private request(req: HttpRequest<any>): Observable<HttpRequest<any>> {
    if (this.refreshInProgress) {
      return this.delayRequest(req);
    }

    return this.addToken(req);
  }

  /**
   * Failed request interceptor, check if it has to be processed with refresh
   */
  private responseError(
    req: HttpRequest<any>,
    res: HttpErrorResponse
  ): Observable<HttpEvent<any>> {
    const authService: AuthService =
      this.injector.get<AuthService>(AUTH_SERVICE);
    const refreshShouldHappen: boolean =
      authService.refreshShouldHappen(res);

    if (refreshShouldHappen && !this.refreshInProgress) {
      this.refreshInProgress = true;

      authService
        .refreshToken()
        .subscribe(
          () => {
            this.refreshInProgress = false;
            this.refreshSubject.next(true);
          },
          () => {
            this.refreshInProgress = false;
            this.refreshSubject.next(false);
          }
        );
    }

    if (refreshShouldHappen && this.refreshInProgress) {
      return this.retryRequest(req, res);
    }

    return throwError(res);
  }

  /**
   * Add access token to headers or the request
   */
  private addToken(req: HttpRequest<any>): Observable<HttpRequest<any>> {
    const authService: AuthService =
      this.injector.get<AuthService>(AUTH_SERVICE);

    return authService.getAccessToken()
      .pipe(
        map((token: string) => {
          if (token) {
            let setHeaders: { [name: string]: string | string[] };

            if (typeof authService.getHeaders === 'function') {
              setHeaders = authService.getHeaders(token);
            } else {
              setHeaders = { Authorization: `Bearer ${token}` };
            }

            return req.clone({ setHeaders });
          }

          return req;
        }),
        first()
      );
  }

  /**
   * Delay request, by subscribing on refresh event, once it finished, process it
   * otherwise throw error
   */
  private delayRequest(req: HttpRequest<any>): Observable<HttpRequest<any>> {
    return this.refreshSubject.pipe(
      first(),
      switchMap((status: boolean) =>
        status ? this.addToken(req) : throwError(req)
      )
    );
  }

  /**
   * Retry request, by subscribing on refresh event, once it finished, process it
   * otherwise throw error
   */
  private retryRequest(
    req: HttpRequest<any>,
    res: HttpErrorResponse
  ): Observable<HttpEvent<any>> {
    const http: HttpClient =
      this.injector.get<HttpClient>(HttpClient);

    return this.refreshSubject.pipe(
      first(),
      switchMap((status: boolean) =>
        status ? http.request(req) : throwError(res || req)
      )
    );
  }

  /**
   * Checks if request must be skipped by interceptor.
   */
  private skipRequest(req: HttpRequest<any>) {
    const skipRequest = this.exec('skipRequest', req);
    const verifyRefreshToken = this.exec('verifyRefreshToken', req);

    // deprecated, will be removed soon
    const verifyTokenRequest = this.exec('verifyTokenRequest', req.url);

    return skipRequest || verifyRefreshToken || verifyTokenRequest;
  }

  /**
   * Exec optional method, will be removed in upcoming updates.
   * Temp method until `verifyTokenRequest` will be completely replaced with skipRequest
   */
  private exec(method: string, ...args: any[]) {
    const authService: AuthService =
      this.injector.get<AuthService>(AUTH_SERVICE);

    if (typeof authService[method] === 'function') {
      return authService[method](...args);
    }
  }

}
